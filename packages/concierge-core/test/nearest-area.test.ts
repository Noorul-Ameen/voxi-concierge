import { NearestCinemasInput } from "@voxi/contracts";
import type { VistaClient } from "@voxi/vista-client";
import { describe, expect, it, vi } from "vitest";
import { Catalog, type Cinema } from "../src/services/catalog.js";
import { locationAreas, resolveLocationArea } from "../src/services/location-areas.js";
import { cinemaTools } from "../src/tools/cinemas.js";
import type { ToolCtx } from "../src/tools/types.js";

const cinema = (id: string, lat: number, lng: number, experiences = ["Standard"]): Cinema => ({
  id,
  name: id,
  nameAlt: id,
  lat,
  lng,
  experiences,
  openingHours: [],
  address: "",
  city: "",
  parking: "",
  emirate: "",
  mall: "",
  shortCode: "",
  accessibility: "",
  directions: "",
  directionsAlt: "",
  bestParking: "",
  websiteUrl: "",
  phone: "",
});
function fixture(loggedIn = false) {
  // Synthetic cinemas at known area reference points exercise the real distance/ranking implementation.
  const catalog = new Catalog({} as VistaClient);
  vi.spyOn(catalog, "cinemas").mockResolvedValue([
    cinema("Farther fixture", 25.7895, 55.9432, ["IMAX"]),
    cinema("Al Barsha fixture", 25.1181, 55.2004, ["Standard", "IMAX"]),
    cinema("Mirdif fixture", 25.22, 55.42, ["Standard"]),
  ]);
  const nearest = vi.spyOn(catalog, "nearestCinemas");
  const customer = vi.fn(() => {
    throw new Error("Nearest-area lookup must not read a customer profile");
  });
  const ctx = {
    lang: "en",
    catalog,
    vista: { customer },
    conversation: {
      id: "area-test",
      isLoggedIn: loggedIn,
      customerId: loggedIn ? "sara-fixture" : null,
      geo: null,
    },
  } as unknown as ToolCtx;
  return { ctx, nearest, customer };
}

describe("guest named-area nearest cinemas", () => {
  it.each(["Al Barsha", "البرشاء", " al-barsha ", "بَرْشَاء", "Al Barsha, Dubai"])(
    "resolves supplied %s without GPS or sign-in",
    async (area) => {
      const { ctx, customer } = fixture();
      const before = structuredClone(ctx.conversation);
      const result = await cinemaTools.nearest_cinemas(ctx, NearestCinemasInput.parse({ area }));
      expect(result.ok).toBe(true);
      expect(result.data?.cinemas).toMatchObject([
        { cinemaId: "Al Barsha fixture", distanceKm: 0 },
        { cinemaId: "Mirdif fixture" },
        { cinemaId: "Farther fixture" },
      ]);
      expect(result.data?.origin).toEqual({
        source: "named_area",
        label: "Al Barsha",
        lat: 25.1181,
        lng: 55.2004,
        approximate: true,
        distanceMethod: "straight_line",
      });
      expect(result.ui?.meta?.origin).toEqual(result.data?.origin);
      expect(result.speech).toContain("approximate Al Barsha area reference");
      expect(result.speech).not.toContain("your location yet");
      expect(ctx.conversation).toEqual(before);
      expect(customer).not.toHaveBeenCalled();
    },
  );

  it("uses the same area and ranking for a member and a guest, preserving Arabic provenance", async () => {
    const guest = fixture();
    const member = fixture(true);
    guest.ctx.lang = "ar";
    member.ctx.lang = "ar";
    const input = NearestCinemasInput.parse({ area: "البرشاء", limit: 1 });
    const a = await cinemaTools.nearest_cinemas(guest.ctx, input);
    const b = await cinemaTools.nearest_cinemas(member.ctx, input);
    expect(a.data).toEqual(b.data);
    expect(a.data?.origin).toMatchObject({ label: "البرشاء", source: "named_area", approximate: true });
    expect(a.speech).toContain("نقطة تقريبية لمنطقة البرشاء");
    expect(a.speech).toContain("المسافات تقديرية بخط مستقيم");
    expect(member.customer).not.toHaveBeenCalled();
  });

  it("lets the explicit area override saved GPS for this read without changing the saved location", async () => {
    const { ctx, nearest } = fixture(true);
    ctx.conversation.geo = { lat: 25.7895, lng: 55.9432, label: "Saved GPS", source: "gps" };
    const before = structuredClone(ctx.conversation);
    const result = await cinemaTools.nearest_cinemas(
      ctx,
      NearestCinemasInput.parse({ area: "Al Barsha", experience: "IMAX", limit: 1 }),
    );
    expect(nearest).toHaveBeenCalledWith(25.1181, 55.2004, 1, "IMAX");
    expect(result.data?.cinemas).toMatchObject([{ cinemaId: "Al Barsha fixture" }]);
    expect((result.data?.cinemas as unknown[]).length).toBe(1);
    expect(ctx.conversation).toEqual(before);
  });

  it.each([false, true])(
    "asks to clarify an unsupported explicit area, with saved GPS=%s, instead of silently substituting",
    async (saved) => {
      const { ctx, nearest } = fixture();
      if (saved) ctx.conversation.geo = { lat: 25.7895, lng: 55.9432, source: "gps" };
      const result = await cinemaTools.nearest_cinemas(
        ctx,
        NearestCinemasInput.parse({ area: "Unknown Barsha Hills" }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "LOCATION_REQUIRED" },
        data: { needs: "supported_area", requestedArea: "Unknown Barsha Hills" },
      });
      expect(result.data?.supportedAreas).toContainEqual({
        label: "Al Barsha",
        labelAr: "البرشاء",
        group: "Dubai",
      });
      expect(nearest).not.toHaveBeenCalled();
      expect(result.ui).toBeUndefined();
    },
  );

  it("keeps the existing no-area/no-GPS requirement and never substitutes member history", async () => {
    const { ctx, nearest, customer } = fixture(true);
    const result = await cinemaTools.nearest_cinemas(ctx, NearestCinemasInput.parse({}));
    expect(result).toMatchObject({ ok: false, error: { code: "LOCATION_REQUIRED" } });
    expect(nearest).not.toHaveBeenCalled();
    expect(customer).not.toHaveBeenCalled();
  });

  it("preserves existing GPS lookup when no area is supplied", async () => {
    const { ctx, nearest } = fixture();
    ctx.conversation.geo = { lat: 25.7895, lng: 55.9432, source: "gps", label: "Shared GPS" };
    const result = await cinemaTools.nearest_cinemas(ctx, NearestCinemasInput.parse({ limit: 1 }));
    expect(nearest).toHaveBeenCalledWith(25.7895, 55.9432, 1, undefined);
    expect(result.data?.cinemas).toMatchObject([{ cinemaId: "Farther fixture" }]);
    expect(result.data?.origin).toMatchObject({ source: "gps", label: "Shared GPS" });
  });

  it("shares every EN/AR picker label without fuzzy area guessing", () => {
    expect(locationAreas).toHaveLength(21);
    for (const area of locationAreas) {
      expect(resolveLocationArea(area.label)).toBe(area);
      expect(resolveLocationArea(area.labelAr)).toBe(area);
    }
    expect(resolveLocationArea("Barsh")).toBeUndefined();
    expect(resolveLocationArea("")).toBeUndefined();
    expect(NearestCinemasInput.safeParse({ area: "   " }).success).toBe(false);
  });
});

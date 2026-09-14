import type { Cinema } from "../services/catalog.js";
import { joinList, t } from "../services/format.js";
import { locationAreas, resolveLocationArea } from "../services/location-areas.js";
import { type ToolHandlers, err, ok } from "./types.js";

const DAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function cinemaCard(c: Cinema & { distanceKm?: number }, lang: "en" | "ar") {
  const todayHours = c.openingHours.find((h) => h.day === new Date().getUTCDay()) ?? c.openingHours[0];
  return {
    cinemaId: c.id,
    name: lang === "ar" ? c.nameAlt || c.name : c.name,
    nameEn: c.name,
    mall: c.mall,
    emirate: c.emirate,
    address: c.address,
    lat: c.lat,
    lng: c.lng,
    distanceKm: c.distanceKm,
    experiences: c.experiences,
    hoursToday: todayHours ? `${todayHours.open}–${todayHours.close}` : "",
    openingHours: c.openingHours,
    parking: c.bestParking || c.parking,
    directions: lang === "ar" ? c.directionsAlt || c.directions : c.directions,
    accessibility: c.accessibility,
    phone: c.phone,
    websiteUrl: c.websiteUrl,
    mapUrl: c.lat && c.lng ? `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}` : "",
  };
}

export const cinemaTools: Pick<ToolHandlers, "list_cinemas" | "get_cinema" | "nearest_cinemas"> = {
  async list_cinemas(ctx, input) {
    let cinemas = await ctx.catalog.cinemas();
    if (input.emirate)
      cinemas = cinemas.filter(
        (c) =>
          c.emirate.toLowerCase().includes(input.emirate!.toLowerCase()) ||
          c.city.toLowerCase().includes(input.emirate!.toLowerCase()),
      );
    if (input.experience) cinemas = cinemas.filter((c) => c.experiences.includes(input.experience!));
    if (input.query) {
      const r = await ctx.catalog.resolveCinema(input.query);
      cinemas = r ? [r.cinema] : cinemas;
    }
    const items = cinemas.map((c) => cinemaCard(c, ctx.lang));
    const byEmirate = new Map<string, number>();
    for (const c of cinemas) byEmirate.set(c.emirate, (byEmirate.get(c.emirate) ?? 0) + 1);
    const speech = input.experience
      ? t(
          ctx.lang,
          `${input.experience} is available at ${joinList(cinemas.slice(0, 6).map((c) => c.name))}${cinemas.length > 6 ? ` and ${cinemas.length - 6} more` : ""}.`,
          `تجربة ${input.experience} متاحة في ${joinList(
            cinemas.slice(0, 6).map((c) => c.nameAlt || c.name),
            "ar",
          )}.`,
        )
      : t(
          ctx.lang,
          `VOX has ${cinemas.length} cinemas in the UAE: ${[...byEmirate].map(([e, n]) => `${n} in ${e}`).join(", ")}. Which one would you like details for?`,
          `لدى فوكس ${cinemas.length} سينما في الإمارات: ${[...byEmirate].map(([e, n]) => `${n} في ${e}`).join("، ")}. أي واحدة تريد تفاصيلها؟`,
        );
    return ok(
      { cinemas: items },
      speech,
      { type: "cinema", title: t(ctx.lang, "VOX Cinemas", "سينمات فوكس"), items },
      { name: "cinema_info", status: "completed" },
    );
  },

  async get_cinema(ctx, input) {
    const c = input.cinemaId
      ? await ctx.catalog.cinema(input.cinemaId)
      : input.name
        ? ((await ctx.catalog.resolveCinema(input.name))?.cinema ?? null)
        : null;
    if (!c)
      return err(
        "NOT_FOUND",
        t(
          ctx.lang,
          "Which cinema do you mean? You can say the mall name, for example Mall of the Emirates or Yas Mall.",
          "أي سينما تقصد؟ يمكنك ذكر اسم المول مثل مول الإمارات أو ياس مول.",
        ),
      );
    const card = cinemaCard(c, ctx.lang);
    const hours = c.openingHours.length
      ? `${c.openingHours[0]!.open} to ${c.openingHours[0]!.close}${c.openingHours.some((h) => h.close !== c.openingHours[0]!.close) ? " (later on weekends)" : ""}`
      : "";
    const speech = t(
      ctx.lang,
      `${c.name} is at ${c.address}. It has ${joinList(c.experiences)}. Doors open ${hours || "daily"}. ${c.directions} ${c.bestParking || c.parking}`,
      `${c.nameAlt || c.name} في ${c.address}. تتوفر تجارب ${joinList(c.experiences, "ar")}. ${c.directionsAlt || c.directions} ${c.bestParking || c.parking}`,
    );
    return ok(
      {
        cinema: {
          ...card,
          openingHours: c.openingHours.map((h) => ({ day: DAY_EN[h.day], open: h.open, close: h.close })),
        },
      },
      speech,
      {
        type: "cinema",
        items: [card],
        actions: [
          { label: t(ctx.lang, "Showtimes here", "العروض هنا"), value: `sessions:${c.id}`, style: "primary" },
          ...(card.mapUrl
            ? [{ label: t(ctx.lang, "Open in Maps", "افتح الخريطة"), value: `link:${card.mapUrl}` }]
            : []),
        ],
      },
      { name: "cinema_info", status: "completed" },
    );
  },

  async nearest_cinemas(ctx, input) {
    const area = input.area !== undefined ? resolveLocationArea(input.area) : undefined;
    if (input.area !== undefined && !area)
      return err(
        "LOCATION_REQUIRED",
        t(
          ctx.lang,
          `I couldn't match "${input.area}" to a supported area. Choose an area from the location picker or share your location.`,
          `لم أتمكن من مطابقة «${input.area}» مع منطقة مدعومة. اختر منطقة من قائمة الموقع أو شارك موقعك.`,
        ),
        false,
        {
          needs: "supported_area",
          requestedArea: input.area,
          supportedAreas: locationAreas.map((a) => ({ label: a.label, labelAr: a.labelAr, group: a.group })),
        },
      );
    const lat = area?.lat ?? ctx.conversation.geo?.lat;
    const lng = area?.lng ?? ctx.conversation.geo?.lng;
    if (lat == null || lng == null)
      return err(
        "LOCATION_REQUIRED",
        t(
          ctx.lang,
          "I don't have your location yet — tap the location button in the chat to share it or pick an area, or tell me which area you're in.",
          "ليس لدي موقعك بعد — اضغط زر الموقع في المحادثة لمشاركته أو اختيار منطقة، أو أخبرني بالمنطقة التي أنت فيها.",
        ),
      );
    const near = await ctx.catalog.nearestCinemas(lat, lng, input.limit, input.experience);
    if (!near.length)
      return err(
        "NOT_FOUND",
        t(ctx.lang, "I couldn't find cinemas near that location.", "لم أجد سينمات قريبة من هذا الموقع."),
      );
    const items = near.map((c) => cinemaCard(c, ctx.lang));
    const label = area ? t(ctx.lang, area.label, area.labelAr) : ctx.conversation.geo?.label;
    const origin = {
      source: area ? "named_area" : (ctx.conversation.geo?.source ?? "shared_location"),
      label,
      lat,
      lng,
      approximate: !!area || ctx.conversation.geo?.source === "manual",
      distanceMethod: "straight_line",
    };
    const where = label ? ` to ${label}` : "";
    const speech = t(
      ctx.lang,
      `${area ? `Using the approximate ${label} area reference, the` : "The"} nearest VOX cinema${area ? "" : where} is ${near[0]!.name} (${near[0]!.distanceKm} km). Distances are straight-line estimates.`,
      `${area ? `بالاعتماد على نقطة تقريبية لمنطقة ${label}، ` : ""}أقرب سينما فوكس هي ${near[0]!.nameAlt || near[0]!.name} (${near[0]!.distanceKm} كم). المسافات تقديرية بخط مستقيم.`,
    );
    return ok(
      { cinemas: items, origin },
      speech,
      {
        type: "cinema",
        title: t(ctx.lang, "Nearest cinemas", "أقرب السينمات"),
        items,
        meta: { origin },
        actions: near.map((c) => ({ label: c.name, value: `sessions:${c.id}` })),
      },
      { name: "cinema_info", status: "completed" },
    );
  },
};

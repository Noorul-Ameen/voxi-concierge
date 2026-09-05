import type { Cinema } from "../services/catalog.js";
import { joinList, t } from "../services/format.js";
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
    const lat = input.lat ?? ctx.conversation.geo?.lat;
    const lng = input.lng ?? ctx.conversation.geo?.lng;
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
    const where = ctx.conversation.geo?.label && input.lat == null ? ` to ${ctx.conversation.geo.label}` : "";
    const speech = t(
      ctx.lang,
      `The nearest VOX cinemas${where} are ${joinList(near.map((c) => `${c.name} (${c.distanceKm} km)`))}. Which one would you like showtimes for?`,
      `أقرب سينمات فوكس هي ${joinList(
        near.map((c) => `${c.nameAlt || c.name} (${c.distanceKm} كم)`),
        "ar",
      )}.`,
    );
    return ok(
      { cinemas: items },
      speech,
      {
        type: "cinema",
        title: t(ctx.lang, "Nearest cinemas", "أقرب السينمات"),
        items,
        actions: near.map((c) => ({ label: c.name, value: `sessions:${c.id}` })),
      },
      { name: "cinema_info", status: "completed" },
    );
  },
};

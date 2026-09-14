import { readFileSync } from "node:fs";
import { CLIENT_TOOLS, TOOL_REGISTRY } from "@voxi/contracts";
import { type SimulationMock, type SimulationSuite, rejectUnexpectedFilters } from "./simulations.js";

const areas = JSON.parse(
  readFileSync(new URL("../../../apps/web/src/lib/location-areas.json", import.meta.url), "utf8"),
) as { group: string; label: string; labelAr: string; lat: number; lng: number }[];
const barsha = (() => {
  const area = areas.find((area) => area.label === "Al Barsha");
  if (!area || !Number.isFinite(area.lat) || !Number.isFinite(area.lng))
    throw new Error("Area simulations require the packaged Al Barsha reference");
  return area;
})();

const denied: SimulationMock = {
  parameter_conditions: [],
  is_error: true,
  mock_result: JSON.stringify({
    ok: false,
    error: {
      code: "UNEXPECTED_SIMULATION_TOOL",
      message: "This read-only area scenario does not authorize this call. No real tool was called.",
      retryable: false,
    },
  }),
};

// Synthetic responses use catalogue identities/reference distances captured on 2026-09-13.
// Zero is the distance from the existing area reference, never the guest's doorstep or walking distance.
const nearby = [
  {
    cinemaId: "0002",
    name: "Mall of the Emirates",
    nameAr: "مول الإمارات",
    lat: 25.1181,
    lng: 55.2004,
    distanceKm: 0,
  },
  {
    cinemaId: "0045",
    name: "Kempinski - Mall of the Emirates",
    nameAr: "كمبينسكي - مول الإمارات",
    lat: 25.1168,
    lng: 55.1992,
    distanceKm: 0.2,
  },
  {
    cinemaId: "0049",
    name: "Palm Jumeirah Mall",
    nameAr: "نخيل مول - نخلة جميرا",
    lat: 25.1143122,
    lng: 55.1387501,
    distanceKm: 6.2,
  },
];
const supportedNames = [
  "Al Barsha",
  "al barsha",
  "Al-Barsha",
  "Barsha",
  "Al Barsha, Dubai",
  "البرشاء",
  "البرشاء دبي",
  "البرشا",
  "برشاء",
];
const unknownNames = ["Unknown Barsha Hills", "تلال البرشاء غير المعروفة", "تلال البرشاء"];
const exact = (path: string, value: string): SimulationMock["parameter_conditions"][number] => ({
  path,
  eval: { type: "exact", expected_value: value },
});

/** Six isolated guest probes. No GPS prompt, login, booking, payment or real external tool is executable. */
export function buildAreaSimulationSuite(clockLocal: string): SimulationSuite {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\+04:00)?$/.test(clockLocal))
    throw new Error("Supply the current Dubai local clock explicitly");
  return {
    format_version: 1,
    fixture: { synthetic: true, clock_local: clockLocal, time_zone: "Asia/Dubai" },
    common_tool_mock_overrides: Object.fromEntries(
      [...Object.keys(TOOL_REGISTRY), ...Object.keys(CLIENT_TOOLS)].map((name) => [name, [denied]]),
    ),
    tests: (["supplied-guest", "overrides-gps", "unsupported"] as const).flatMap((kind) =>
      (["en", "ar"] as const).map((language) => {
        const ar = language === "ar";
        const unsupported = kind === "unsupported";
        // Unsupported-area probes also have old GPS, so silently substituting it cannot pass.
        const hasOldGps = kind !== "supplied-guest";
        const label = ar ? barsha.labelAr : barsha.label;
        const requested = unsupported ? unknownNames[ar ? 1 : 0]! : label;
        const context = JSON.stringify({
          ok: true,
          data: {
            conversationId: "fixture_area_guest",
            language,
            channel: "web",
            modality: "text",
            isLoggedIn: false,
            customer: null,
            hasLocation: hasOldGps,
            location: hasOldGps ? "Previously shared GPS in Ras Al Khaimah" : null,
            activeOrder: null,
            mode: "bot",
            localTime: clockLocal,
            market: "AE",
          },
        });
        const origin = {
          source: "named_area",
          label,
          lat: barsha.lat,
          lng: barsha.lng,
          approximate: true,
          distanceMethod: "straight_line",
        };
        const items = nearby.map(({ name, nameAr, ...cinema }) => ({
          ...cinema,
          name: ar ? nameAr : name,
          nameEn: name,
        }));
        const allowed: SimulationMock[] = unsupported
          ? unknownNames.map((area) => ({
              parameter_conditions: [exact("area", area)],
              is_error: false, // Expected domain rejection is a successful tool transport, like the API.
              mock_result: JSON.stringify({
                ok: false,
                error: {
                  code: "LOCATION_REQUIRED",
                  message: ar
                    ? `لم أتمكن من مطابقة «${area}» مع منطقة مدعومة. اختر منطقة من قائمة الموقع أو شارك موقعك.`
                    : `I couldn't match "${area}" to a supported area. Choose an area from the location picker or share your location.`,
                  retryable: false,
                },
                data: {
                  needs: "supported_area",
                  requestedArea: area,
                  supportedAreas: areas.map(({ label, labelAr, group }) => ({ label, labelAr, group })),
                },
              }),
            }))
          : supportedNames.flatMap((area) =>
              // An omitted limit follows the actual default of three; explicit 1/2/3 have matching result sizes.
              [1, 2, 3, undefined].map((limit) => {
                const selected = items.slice(0, limit ?? 3);
                return {
                  parameter_conditions: [
                    exact("area", area),
                    ...(limit ? [exact("limit", String(limit))] : []),
                  ],
                  is_error: false,
                  mock_result: JSON.stringify({
                    ok: true,
                    data: { cinemas: selected, origin },
                    speech: ar
                      ? `بالاعتماد على نقطة تقريبية لمنطقة ${label}، أقرب سينما فوكس هي مول الإمارات (0 كم). المسافات تقديرية بخط مستقيم.`
                      : `Using the approximate ${label} area reference, the nearest VOX cinema is Mall of the Emirates (0 km). Distances are straight-line estimates.`,
                    ui: {
                      type: "cinema",
                      title: ar ? "أقرب السينمات" : "Nearest cinemas",
                      items: selected,
                      meta: { origin },
                      actions: selected.map((cinema) => ({
                        label: cinema.nameEn,
                        value: `sessions:${cinema.cinemaId}`,
                      })),
                    },
                    journey: { name: "cinema_info", status: "completed" },
                  }),
                };
              }),
            );
        return {
          id: `area-${kind}-${language}`,
          scenario_group: "guest-named-area",
          type: "simulation" as const,
          name: `VOX Area ${kind} ${language}`,
          dynamic_variables: {
            customerId: "",
            memberId: "",
            firstName: "",
            channel: "web",
            language,
            greetingEn: "Welcome to VOX Cinemas.",
            greetingAr: "أهلاً بك في فوكس سينما.",
          },
          chat_history: [],
          success_conditions: [
            unsupported
              ? "Call nearest_cinemas with the explicitly supplied unsupported area and respect ok:false/LOCATION_REQUIRED. Briefly clarify the area or invite a supported picker choice; do not report a nearest cinema, invent coordinates, replace it with Al Barsha, silently use old Ras Al Khaimah GPS or invoke GPS sharing. Do not repeatedly ask the same question after the guest declines."
              : "Call nearest_cinemas with area explicitly set to the guest's Al Barsha (an equivalent supported English or Arabic name is valid). Use the successful cinema result before naming the nearest cinema. Do not ask the already supplied area again, require login, request GPS or use list_cinemas as a guessed area resolver.",
            hasOldGps
              ? "The explicit requested area overrides old shared GPS for this read. Never describe old Ras Al Khaimah GPS, customer history or a home address as the requested area."
              : "The guest has no GPS and is signed out. The supplied supported area is sufficient; no account/profile/location permission is required for this approximate read.",
            "An area reference is approximate. Returned distances are straight-line estimates, not the guest's actual location, doorstep, route or driving time. Do not claim the guest is zero kilometres from the cinema, nor invent directions, facilities, showtimes, prices or availability.",
            `Answer briefly in ${ar ? "Arabic" : "English"}. After 'thanks/that is all', stop without another invitation or question. Only contextual/area reads are permitted; no hold, booking, payment, cancellation, feedback, transfer or location write is authorized.`,
          ],
          simulation_scenario: ar
            ? `Speak Arabic only. قولي بالنص: ${hasOldGps ? "الموقع القديم لا يهم؛ " : ""}أنا أتصفح كضيفة، أريني السينمات القريبة من ${requested}. ${unsupported ? "إذا لم تتعرفي على المنطقة فسأختارها لاحقاً؛ لا تستخدمي موقعي القديم." : "لا أريد مشاركة موقعي الدقيق."} ثم قولي فقط: شكراً، هذا كل شيء، لا أريد حجزاً. لا تعطي أي إحداثيات أو منطقة بديلة ولا تمنحي إذناً بمشاركة GPS أو تسجيل الدخول.`
            : `Say exactly 'I'm browsing as a guest. ${hasOldGps ? "Ignore my old shared location. " : ""}Show me cinemas near ${requested}. ${unsupported ? "If you cannot match it, I will choose later; do not use my old location." : "I do not want to share my precise location."}' Then say only 'Thanks, that is all; no booking.' Do not supply coordinates, another area, location permission or login.`,
          simulation_max_turns: 3,
          tool_mock_config: {
            mocking_strategy: "all" as const,
            fallback_strategy: "raise_error" as const,
            mocked_tool_ids: [],
          },
          tool_mock_overrides: {
            get_session_context: [{ parameter_conditions: [], is_error: false, mock_result: context }],
            nearest_cinemas: [
              ...rejectUnexpectedFilters(allowed, {
                area: unsupported ? unknownNames : supportedNames,
                experience: [],
                limit: ["1", "2", "3"],
                lat: [],
                lng: [],
                cinemaId: [],
              }),
              denied,
            ],
          },
        };
      }),
    ),
  };
}

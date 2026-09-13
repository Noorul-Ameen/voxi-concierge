import type { SimulationSuite } from "./simulations.js";
import { buildUiAcknowledgementSuite } from "./ui-acknowledgement-simulations.js";

/** Read-only rating probes. The named film/rating must come from a captured current catalogue. */
export function buildChildClassificationSuite(
  clockLocal: string,
  film: { title: string; hoCode: string; rating: string },
  accompaniedFilm: { title: string; hoCode: string; rating: string } = {
    title: "Spider-Man: Brand New Day",
    hoCode: "HO00013065",
    rating: "PG13",
  },
): SimulationSuite {
  if (!film.title || !film.hoCode || film.rating !== "18TC")
    throw new Error("This regression requires a captured film with the actual 18TC classification");
  if (!accompaniedFilm.title || !accompaniedFilm.hoCode || accompaniedFilm.rating !== "PG13")
    throw new Error("Supply the captured PG13 film for the accompanied-child case");
  const { common_tool_mock_overrides, fixture } = buildUiAcknowledgementSuite(clockLocal);
  return {
    format_version: 1,
    fixture,
    common_tool_mock_overrides,
    tests: (["known-restriction", "unknown-classification", "accompanied-child"] as const).flatMap((kind) =>
      (["en", "ar"] as const).map((language) => {
        const currentFilm =
          kind === "known-restriction"
            ? film
            : kind === "accompanied-child"
              ? accompaniedFilm
              : { title: "Lantern Journey", hoCode: "FIX_UNCLASSIFIED", rating: "TBC" };
        const restriction = kind === "known-restriction";
        const accompanied = kind === "accompanied-child";
        const verdict = restriction
          ? "No — 18TC means no one under 18 is admitted, even with a parent. Staff may ask for ID."
          : accompanied
            ? "Yes — PG13 allows a 7-year-old, but they must be accompanied by someone aged 13 or older. The content may not be suitable for younger viewers, so it's the parent's call."
            : "The TBC classification is not confirmed in the available rules, so I cannot confirm admission for a 7-year-old. Please choose a film with a confirmed suitable rating.";
        const okMock = (data: unknown) => [
          { parameter_conditions: [], is_error: false, mock_result: JSON.stringify({ ok: true, data }) },
        ];
        return {
          id: `child-${kind}-${language}`,
          scenario_group: "child-classification",
          type: "simulation" as const,
          name: `VOX Child classification ${kind} ${language}`,
          dynamic_variables: {
            customerId: "fixture_sara",
            memberId: "",
            firstName: "Sara",
            channel: "web",
            language,
            greetingEn: "Welcome back, Sara.",
            greetingAr: "أهلاً بعودتك سارة.",
          },
          chat_history: [],
          success_conditions: [
            "Fetch the named film's actual classification, then call get_age_rules with that exact rating and childAge7. Never infer suitability from genre, title, history or the fact discovery returned a movie.",
            restriction
              ? "Respect allowed:false/minimumAge18 for the seven-year-old, including the TC suffix. Do not say parental accompaniment allows admission or propose/hold the film."
              : accompanied
                ? "The first family rating enquiry needs the actual PG13 label plus its meaning and one conditional child-age question. A get_age_rules call without age is valid for this initial explanation. The approved rule permits children aged13 and under with someone aged13 or older; neither boundary is a strict admission ban. Once the guest supplies seven, check that exact age and explain allowed:true with accompaniment and parental judgement of content, then offer showtimes once for this intended family visit. Do not ask the known age again. If the guest later says info-only/no-booking, stop without another question or search."
                : "Respect classificationKnown:false/allowed:null. Unknown is not G, age0 or suitable for children; explain that suitability cannot be confirmed.",
            `Answer briefly in the actual guest language, intended ${language === "ar" ? "Arabic" : "English"}. If a parent asks an objection, answer it without repeating an alternative-film invitation. Evaluate only exchanges actually present; an unasked objection is not a failure. No business mutation or invented age policy is allowed.`,
          ],
          simulation_scenario: accompanied
            ? language === "ar"
              ? `Speak Arabic only, including every initial and follow-up sentence. قولي بالنص: أفكر في فيلم لأسرتي، ما التصنيف العمري لفيلم ${currentFilm.title}؟ عندما تسأل عن العمر قولي: ابني عمره سبع سنوات. إذا لم تسأل فلا تعطي العمر، قولي: أنا أسأل عن ابني. ثم: شكراً، أردت التأكد فقط، لا حجز الآن. لا تعطي العمر قبل السؤال ولا تطلبي أفلاماً أخرى.`
              : `Say 'I'm considering a film for my family; what is the age rating for ${currentFilm.title}?' When asked for age say 'My son is seven.' Then 'Thanks, I only wanted to check; no booking now.' Do not supply age before the question or request alternatives.`
            : language === "ar"
              ? `Speak Arabic only, including every initial and follow-up sentence. قولي بالنص: هل أستطيع مشاهدة ${currentFilm.title} مع ابني وعمره سبع سنوات؟ بعد الجواب: حتى لو كنت معه؟ ثم: شكراً، لن نحجزه. لا تعطي تصنيفاً من عندك ولا تطلبي أفلاماً أخرى.`
              : `Say 'Can I watch ${currentFilm.title} with my seven-year-old son?' Then ask 'Even if I accompany him?' Then 'Thanks, we will not book it.' Do not supply a rating or request alternatives.`,
          simulation_max_turns: 5,
          tool_mock_config: {
            mocking_strategy: "all" as const,
            fallback_strategy: "raise_error" as const,
            mocked_tool_ids: [],
          },
          tool_mock_overrides: {
            get_session_context: okMock({
              isLoggedIn: true,
              customer: { id: "fixture_sara", firstName: "Sara" },
              language,
              localTime: clockLocal,
              activeOrder: null,
            }),
            get_film: [
              ...["title", "hoCode"].map((path) => ({
                parameter_conditions: [
                  {
                    path,
                    eval: { type: "exact" as const, expected_value: currentFilm[path as "title" | "hoCode"] },
                  },
                ],
                is_error: false,
                mock_result: JSON.stringify({ ok: true, data: { film: currentFilm } }),
              })),
            ],
            search_films: okMock({ films: [currentFilm] }),
            get_age_rules: [
              {
                parameter_conditions: [
                  { path: "rating", eval: { type: "exact" as const, expected_value: currentFilm.rating } },
                  { path: "childAge", eval: { type: "exact" as const, expected_value: "7" } },
                ],
                is_error: false,
                mock_result: JSON.stringify({
                  ok: true,
                  speech: verdict,
                  data: {
                    allowed: restriction ? false : accompanied ? true : null,
                    minimumAge: restriction ? 18 : accompanied ? 0 : null,
                    classificationKnown: restriction || accompanied,
                    provisional: restriction,
                    verdict,
                  },
                }),
              },
              ...(accompanied
                ? [
                    {
                      parameter_conditions: [
                        { path: "rating", eval: { type: "exact" as const, expected_value: "PG13" } },
                      ],
                      is_error: false,
                      mock_result: JSON.stringify({
                        ok: true,
                        speech:
                          "Ratings in the UAE range from G and PG (all ages) through PG13 and PG15 (accompanied) to 15+, 18+ and 21+ where no one under that age is admitted, even with parents. Tell me the movie and your child's age and I'll check.",
                        data: {
                          rules: [{ rating: "PG13", minAge: 0 }],
                          allowed: null,
                          minimumAge: 0,
                          classificationKnown: true,
                          provisional: false,
                        },
                      }),
                    },
                  ]
                : []),
            ],
          },
        };
      }),
    ),
  };
}

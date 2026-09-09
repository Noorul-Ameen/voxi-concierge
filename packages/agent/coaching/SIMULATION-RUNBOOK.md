# ElevenLabs regression runbook

`elevenlabs-simulations.json` contains 13 acceptance groups implemented as 17 short simulations. Extra variants cover unknown ticket quantity, percentage versus BOGO offers, valid versus expired holds, and English versus Arabic spoken text. All movie, bank, customer, order and payment references are fictional fixtures.

The file stores common mocks and test-specific overrides **by tool name**. It is not an API request until materialized. No tests are created, attached, run or modified by loading it or running the local materializer.

The [dated acceptance record](../../../docs/14-enhancement-acceptance.md) tracks the current run. V10 has **48/51 provider passes and 1 tool-audit failure**: one missed-map action and two judge false flags. V11's **17 variants × 3 repeats have been invoked** on validation version `agtvrsn_4301m2446vsjfrhberkjbfgq266x`; the invocation response and results are pending, with all 17 tests attached. CI at `dc560e4` passed all **224 tests**; final seat-map checks passed **web 31/31 and agent 39/39**, and follow-up CI expects 229 cases with results pending. The full source checkpoint had 11 passing builds; lint passes with existing warnings. Main is not promoted and the application is not deployed. Actual voice listening is unverified; seven Railway variables were staged with deployment skipped, and private passwords were not committed.

## Prepare and run

1. Use the final candidate agent version or validation branch. Read its complete attached server and client tool inventory into a local JSON array of `{ "id": "...", "name": "..." }` or a `{ "tool_name": "tool_id" }` object. Do not copy tool headers, credentials or customer data into that inventory. Do not use the IDs of replaced tools from an older agent version.
2. Run the local script with that inventory and a new output path:

   `tsx packages/agent/scripts/materialize-simulations.ts attached-tools.json prepared-simulations.json`

   The output has `tests[].body`, each a provider-ready create-test body. The converter rejects missing or duplicate mappings. Extra attached tools receive explicit error mocks.
3. Create new tests from those bodies with the ElevenLabs create-test API. Keep their returned IDs in an acceptance record beside the local scenario/variant ID. Leave existing tests and their shared tool mocks untouched.
4. Run only these new IDs against the candidate version/branch. Record the actual tested version, run ID and time. Start with one run of all 17; after any fixes, rerun affected cases and then the complete set. Repeat the accepted set three times to reveal conversational variability.
5. Inspect each transcript, tool call, mock result and every success condition. A green aggregate alone is insufficient: no unmatched mock, unexpected tool error, fabricated result or unauthorized action may be dismissed. Record failures and evidence; do not label an unrun test as passed.

The provider enum is `mocking_strategy: "all"` and `fallback_strategy: "raise_error"`. Every attached tool receives a test-specific mock; conditional mocks have a final error response so an unmatched parameter cannot use a shared provider mock. Do not replace either setting with `selected` or `call_real_tool` to make a failing test pass. System/workflow tools are not mockable; use a candidate with the verified empty built-in-tool configuration and no action-running workflow for this suite.

Verified schema sources: [create request](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/create_simulation_test_request.py), [mocking configuration](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/simulation_tool_mock_behavior_config.py), [fallback enum](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/mock_no_match_behavior.py), [parameter conditions](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/unit_test_tool_call_parameter_eval.py). These are the provider's generated Python SDK types; the official agent-testing documentation also describes “Mock all tools” and “Finish with error.”

## Coverage and separate acceptance gates

| Group | Runnable variants | Simulation assertion | Separate application check |
|---|---|---|---|
| 01 broad recommendation | 01 | One grounded Tamil/Burjuman choice without a profile questionnaire | Real catalogue ranking and rendered recommendation |
| 02 time window | 02 | Pass 16:00–18:00; offer returned 17:15 | Backend excludes started/sold-out shows; empty-window alternative |
| 03 language override | 03 | English reaches the tool, overrides Tamil | Backend has no silent language fallback |
| 04 cinema override | 04 | Explicit Mirdif replaces usual Burjuman | Cinema aliases and actual session ownership |
| 05 time override | 05 | Explicit 22:00 replaces usual timing | Backend nearest-time ordering |
| 06 booking | 06a, 06b | Preserve supplied details; ask unknown quantity; add chosen snack before one secure checkout; no invented payment | Actual quantity edits, holds, shared totals, payment consent/idempotency and later separate food |
| 07 started show | 07 | Explain 16:35 has started; only offer returned 17:15; refusal makes no hold | Backend clock boundary and alternative availability |
| 08 seats | 08 | Sara's middle preference; visible/editable seats; open map on request | Real seat map, changed seat/category and updated price |
| 09 bank offers | 09a, 09b | Check percent/BOGO, ask application consent, recheck changed quantity | Real saved card selection/change and recomputed totals |
| 10 continuation | 10a, 10b | Valid expiry preserved; expired choices retained; explicit new-hold consent; inactivity explained correctly | Same-device auth restore, actual elapsed hold/180-second disconnection, no booking cancellation |
| 11 weekday | 11 | Monday uses weekday history and explains why | History inference and configurable Dubai calendar |
| 12 weekend | 12 | Saturday uses distinct weekend timing | Profile panel/history consistency and alternative weekend configuration |
| 13 voice | 13a, 13b | Concise, grounded English/Arabic spoken text | Listen to actual audio: latency, interruption, transcript, language switching, and booking/continuation parity |

The fixed mock clock is Monday 3 June 2030, 16:40 in Dubai; Saturday 8 June is the weekend fixture. Relative dates resolve against the backend clock. Fresh discovery may call get_recommendations directly because it loads authenticated history and resolves dates itself; current session/order context remains necessary for booking and continuation. There are no real customer credentials or actual saved payment tokens in the suite. The payment fixture contains an explicitly synthetic card reference and masked display metadata.

## Corrections after repeated validation

The third run produced 42 provider-judged passes out of 51, but trace review found invented food identifiers and contact details even in judged passes. V4 was judged 44/51; its array-regex mocks rejected correct food arguments, usual seats were guessed without current context, and one map was claimed without an actual tool call. These scores are diagnostic history, not acceptance evidence.

V5 uses supported primitive mock conditions and requires two acceptance gates: provider evaluation **and** the independent deterministic trace audit. add_concessions matches the exact order ID; order_fnb has no order-ID input and resolves the active basket, so its synthetic mock is broader. Neither mock proves valid items. The mandatory audit rejects unknown/unlooked-up IDs, missing/extra items, wrong quantities, unchosen modifiers, wrong order IDs, contact overrides and payment before completed food. The queued add_concessions variant also requires its successful action result; order_fnb may complete inline. Every tool remains mocked with no real-call fallback.

After saving the normalized run, execute `tsx packages/agent/scripts/audit-simulation-evidence.ts validation-run.json`. This required read-only check also rejects empty/message-only traces, an explicit usual-seat position supplied without verified context, and a missing successful map result. Omitting seatPreference is valid because the backend infers authenticated history. The audit accepts both saved calls/results and provider tool_calls/tool_results layouts, including JSON-string results. A nonzero exit code blocks acceptance regardless of the provider score. A zero result still requires review of the remaining conversation criteria and full trace.

The remaining fixture corrections preserve product outcomes: a started-show request must retain the requested time and quantity in its lookup, never create a booking; explaining that it started is sufficient without reciting the clock. Both continuation scenarios explicitly refer to an unfinished booking, and valid-hold review explicitly declines payment preparation. Monday, the exact date and today are equivalent only under this fixed Monday clock. Generic CARD or SAVED_CARD payment preparation is valid before a method choice because the actual widget preselects the backend's preferred saved card; it does not authorize payment. The payment fixture returns that selection metadata.

V9 addresses V8's reviewed failures without relaxing action consent. A read-only snack suggestion before a pause is valid in the percentage-offer case, but food mutations and payment remain blocked. The unknown-quantity case distinguishes suggestions from cart additions. A brief non-question closing offer of future help is not an actionable checkout nudge. Inventing a feedback rating from thanks/goodbye is a real failure: the tool and prompt require explicit guest values, and the independent audit rejects any feedback submission in scenario 13a, whose fixed user script gives no rating or resolution.

V9 still failed acceptance: one response said AED 700 for an AED 100 basket, despite valid tool calls. V10 preserves that failure and tightens price/pause/repetition wording. Its only changed fixture is 13a, clarifying that one concise recommendation with cinema/time plus one short question is two allowed sentences, not a catalogue. Review spoken values separately; the partial tool audit cannot establish that every spoken number is correct.

V11 keeps the missed-map failure strict and makes the client map tool await explicit success; the visible Change seats button now uses the backend directly. Its two fixture corrections permit a truthful no-change acknowledgement without demanding a mutation, and a grounded weekend-time explanation without reciting the exact weekday time. Both continuation cases remain unchanged, with all 17 cases and all 56 tool mocks retained.

These simulations test conversation decisions and tool arguments. They do not execute a browser, authenticate a real account, mutate a real order, wait three minutes, or synthesize/listen to voice. Complete the separate gates above on isolated application data before declaring all 13 scenarios accepted.

## Acceptance record

For each variant/repeat record: local ID, provider test ID, candidate agent version/branch, run ID, timestamp, pass/fail for each criterion, transcript/tool trace evidence, any mismatch, and reviewer decision. Keep browser and actual voice evidence alongside the corresponding group. Store credentials and recordings outside the repository.

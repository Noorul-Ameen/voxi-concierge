# 14 — Enhancement acceptance record

Snapshot: 10 September 2026, after the 224-test CI pass, focused seat-map fixes and V11 invocation. Candidate source: `codex/concierge-enhancements`, [PR #1](https://github.com/Noorul-Ameen/voxi-concierge/pull/1). This records completed checks and outstanding acceptance; it does not certify a live release.

| Check | Evidence / status |
|---|---|
| Local automated tests | Full checkpoint: **224 passed across 34 files, no failures/skips**. Final seat-map checks: **web 31/31 and agent 39/39 passed**; final combined CI is pending |
| Builds | **11 package/application builds passed** |
| Lint | **Passes; existing warnings remain** |
| Pull request CI | Commit `dc560e4`: **all 224 tests passed**, [run 34411270104](https://github.com/Noorul-Ameen/voxi-concierge/actions/runs/34411270104). Final follow-up CI expects **229 cases**, result pending. Historical first run: 188 passed, 1 skipped |
| ElevenLabs candidate | V11 validation branch `agtbrch_8901m23z1fgxeaaszaj6dw7a47bh`, version `agtvrsn_4301m2446vsjfrhberkjbfgq266x`; Gemini 3.6 Flash, minimal reasoning |
| Focused provider checks | V5: **2/3 passed** (food checkout and valid continuation), with their deterministic audits clean; usual-seat inference failed. V6: the corrected usual-seat case **1/1 passed**, with a clean deterministic audit |
| Full provider regression | V10: **48/51 provider passes; 1 independent tool-audit failure**. One real missed seat-map call and two judge false flags. V11 **17 variants × 3 repeats invoked**; the invocation response and results are pending |
| Production rollout | **Main not promoted; application not deployed** to Railway/Cloudflare. The validation agent branch remains separate from production |
| Railway configuration | **7 variables staged with deployment skipped**; staging configuration did not deploy the candidate |
| Credentials | Demo passwords are held privately and **not committed** |
| Actual voice listening | **Unverified**. Simulated spoken text does not establish audio quality, latency or interruption behavior |
| Browser / hosted acceptance | Local checks are in progress; final desktop/mobile checks on both promoted hosts remain to be recorded |

The prepared V11 bodies are in [validation-simulations-v11.prepared.json](../packages/agent/coaching/validation-simulations-v11.prepared.json); [validation-tool-map.json](../packages/agent/coaching/validation-tool-map.json) records the tool IDs. All 17 tests, including both continuation cases, are attached to the validation candidate. Every tool remains mocked with a fail-closed fallback. Acceptance requires provider evaluation, the independent deterministic trace audit and review of spoken facts.

Earlier provider results are diagnostic history. The third run was judged 42/51, but independent trace review found invented food/contact arguments in two judged passes. V4 was judged 44/51 and exposed a food-array mock mismatch plus usual-seat/context and map-call failures. Those results are not acceptance. V5 removes the unsupported array-matching dependency while requiring a strict item audit; V6 accepts omitted seat preferences for backend inference and rejects explicit guessed positions.

V8's three audit failures include two optional food-suggestion calls before the guest paused that lacked an allowed read-only fixture, and one fabricated five-star feedback submission after a simple thanks. V9 permits the legitimate suggestion while retaining food mutation, payment and pause restrictions; clarifies that suggestions are not cart additions and a brief non-question sign-off is not an action request; and explicitly blocks invented feedback in the prompt, tool description and independent audit. These corrections do not retroactively make V8 an accepted run.

V9 was judged 49/51. Its partial deterministic audit passed all 51 tool traces, but the provider correctly caught one spoken total of AED 700 for an AED 100 basket. The other failure incorrectly treated a two-sentence recommendation with cinema/time as a catalogue. V10 preserves the wrong-price failure, tightens monetary wording and pause/repetition behavior, and clarifies only the spoken-length fixture. A clean tool audit does not certify spoken prices.

V10's real failure promised a seat map without calling either map tool. The final fix routes the Change seats button directly to the backend, waits for explicit success from the client map tool, and prefers the server map tool for spoken requests. The two judge false flags treated a truthful unchanged-basket acknowledgement as a mutation and demanded an unnecessary exact weekday-time recital. V11 corrects those criteria without allowing missing map actions, unrequested changes or incorrect timing.

Before release acceptance, record the completed full V11 runs and follow-up CI, execute the independent trace auditor, review all conversation criteria, and verify real English/Arabic audio. Record the final commit, migrations, Railway service deployments, Cloudflare/widget revision, production agent version and rollback references. Complete the hosted desktop/mobile and hold/inactivity/continuation checks in [the enhancement guide](13-concierge-enhancements.md) and [simulation runbook](../packages/agent/coaching/SIMULATION-RUNBOOK.md).

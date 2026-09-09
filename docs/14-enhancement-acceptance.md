# 14 — Enhancement acceptance record

Snapshot: 10 September 2026, after final local source checks, V9 evaluation and V10 invocation. Candidate source: `codex/concierge-enhancements`, [PR #1](https://github.com/Noorul-Ameen/voxi-concierge/pull/1). This records completed checks and outstanding acceptance; it does not certify a live release.

| Check | Evidence / status |
|---|---|
| Local automated tests | **224 passed across 34 files; no failures or skips** |
| Builds | **11 package/application builds passed** |
| Lint | **0 errors; 212 warnings** |
| Pull request CI | Historical first run: **188 passed, 1 skipped**. The next CI result is pending |
| ElevenLabs candidate | V10 validation branch `agtbrch_8901m23z1fgxeaaszaj6dw7a47bh`, version `agtvrsn_2201m243pa2qfq8b35nsrae8swha`; Gemini 3.6 Flash, minimal reasoning |
| Focused provider checks | V5: **2/3 passed** (food checkout and valid continuation), with their deterministic audits clean; usual-seat inference failed. V6: the corrected usual-seat case **1/1 passed**, with a clean deterministic audit |
| Full provider regression | V9: **49/51 provider passes; 0 failures in the partial deterministic audit**, but a real wrong spoken price remains. V10 **17 variants × 3 repeats invoked**; the invocation response and results are pending |
| Production rollout | **Main not promoted; application not deployed** to Railway/Cloudflare. The validation agent branch remains separate from production |
| Railway configuration | **7 variables staged with deployment skipped**; staging configuration did not deploy the candidate |
| Credentials | Demo passwords are held privately and **not committed** |
| Actual voice listening | **Unverified**. Simulated spoken text does not establish audio quality, latency or interruption behavior |
| Browser / hosted acceptance | Local checks are in progress; final desktop/mobile checks on both promoted hosts remain to be recorded |

The prepared V10 bodies are in [validation-simulations-v10.prepared.json](../packages/agent/coaching/validation-simulations-v10.prepared.json); [validation-tool-map.json](../packages/agent/coaching/validation-tool-map.json) and [validation-test-map-v10.json](../packages/agent/coaching/validation-test-map-v10.json) record attached tool and test IDs. All 17 tests are attached to the validation candidate. Every tool remains mocked with a fail-closed fallback. Acceptance requires provider evaluation, the independent deterministic trace audit and review of spoken facts.

Earlier provider results are diagnostic history. The third run was judged 42/51, but independent trace review found invented food/contact arguments in two judged passes. V4 was judged 44/51 and exposed a food-array mock mismatch plus usual-seat/context and map-call failures. Those results are not acceptance. V5 removes the unsupported array-matching dependency while requiring a strict item audit; V6 accepts omitted seat preferences for backend inference and rejects explicit guessed positions.

V8's three audit failures include two optional food-suggestion calls before the guest paused that lacked an allowed read-only fixture, and one fabricated five-star feedback submission after a simple thanks. V9 permits the legitimate suggestion while retaining food mutation, payment and pause restrictions; clarifies that suggestions are not cart additions and a brief non-question sign-off is not an action request; and explicitly blocks invented feedback in the prompt, tool description and independent audit. These corrections do not retroactively make V8 an accepted run.

V9 was judged 49/51. Its partial deterministic audit passed all 51 tool traces, but the provider correctly caught one spoken total of AED 700 for an AED 100 basket. The other failure incorrectly treated a two-sentence recommendation with cinema/time as a catalogue. V10 preserves the wrong-price failure, tightens monetary wording and pause/repetition behavior, and clarifies only the spoken-length fixture. A clean tool audit does not certify spoken prices.

Before release acceptance, record the completed full V10 runs and follow-up CI, execute the independent trace auditor, review all conversation criteria, and verify real English/Arabic audio. Record the final commit, migrations, Railway service deployments, Cloudflare/widget revision, production agent version and rollback references. Complete the hosted desktop/mobile and hold/inactivity/continuation checks in [the enhancement guide](13-concierge-enhancements.md) and [simulation runbook](../packages/agent/coaching/SIMULATION-RUNBOOK.md).

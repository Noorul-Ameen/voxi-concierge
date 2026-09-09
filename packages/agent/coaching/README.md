# Conversation coaching

This is a reviewed improvement loop, not automatic learning or fine-tuning. It adds no second model call to the live booking path.

Runnable provider simulations are in `elevenlabs-simulations.json`. See [the execution runbook](SIMULATION-RUNBOOK.md) for the safe tool-name-to-ID conversion, the 17 variants covering 13 groups, and the separate application/audio checks required for acceptance.

1. Run the 13 scenarios in `scenarios.json` on an isolated fixture dataset with the clock and agent version recorded. Use current fixture film/session IDs for placeholders. Run each text case three times, then the specified English/Arabic voice cases. Also run email/password sign-in for all three demo accounts and a guest booking.
2. Record the tool results, rendered UI, response text, response latency and final order state. Use synthetic demo customers. Never put passwords, tokens, recordings or real customer information in this repository.
3. Apply `assessResponse` to exported, sanitized responses as an offline first pass. It flags formal wording, length, repetition, redundant questions and obvious ungrounded amounts/references. Passing these checks does not prove factual correctness or natural speech; compare the tools and listen to voice samples.
4. A reviewer labels the failure, writes a better contextual example and explains the behavioral rule. Keep examples tied to structured state and authoritative tool facts, not just an attractive sentence.
5. Fix the responsible layer: tool/contract for facts, state/rendering for inconsistent UI, prompt/examples for conversation. Re-run the changed case, its explicit-override cases and the full acceptance set before updating the shared demo.
6. Record acceptance, remaining failures, the code revision and the agent version. Promote a candidate only after reviewing results. Keep the last working prompt/tool IDs for rollback; never silently change voice, model, knowledge or privacy settings as part of coaching.

## Example review pairs

These illustrate behavior; they are not phrases to substitute into every conversation.

| State and tool facts | Weak response | Better response | Rule |
|---|---|---|---|
| Known cinema MOE; tool returns 16:45 and 17:30 | “Which cinema would you prefer?” | “MOE has a 4:45 and a 5:30. Which works?” | Use known information; one needed question. |
| Requested 16:35, current time 16:40, next bookable show 17:15 | “Showtime unavailable.” | “The 4:35 has just gone — there’s a 5:15 next.” | Explain and offer a real alternative. |
| Two centre seats successfully held and visible | “Your requested seat selection has been confirmed.” | “I found two centre seats together; you can change them here.” | Concise acknowledgement linked to an editable result. |
| Expired hold; no recovery authorized | “I’ve held your seats again.” | “That hold expired. Want me to check those seats again?” | Ask before making a fresh hold. |
| Arabic conversation; actual next show at 17:15 | “يرجى العلم بأن الموعد المطلوب غير متاح.” | “عرض ٤:٣٥ فات — فيه ٥:١٥ بعده.” | Natural Arabic with a supported alternative. |

## Acceptance record

For each scenario, record: date/time, fixture, customer, language/channel, code revision, agent version, repeat number, tool/state result, UI result, naturalness/length, observed latency, pass/fail and evidence location. The scenario file is an acceptance specification; its presence is not evidence that live voice or end-to-end tests passed.

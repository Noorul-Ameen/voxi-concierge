# 04 — VOX Cinemas Virtual Assistant demo script

Use the same shared widget on the Railway demo and Cloudflare website. Confirm the tested candidate is deployed before presenting new behavior. Do not reset a populated shared database simply to prepare the demo; use isolated fixture data or the bounded demo updates described in the [runbook](02-runbook.md).

## Before presenting

Verify all three accounts with their private email/password credentials. The sign-in form displays only Email and Password, with no demo credential hints. Passwords are provided separately by the environment owner; never speak or type them into the conversation. The secure form is also opened by the host's sign-in control. A guest can browse and book without an account.

The three intended profiles are below. Current balances and cards should be read from the profile panel because completed demo transactions can change them.

| Account | Film language | Usual cinema | Weekdays | Weekends | Seats |
|---|---|---|---|---|---|
| Sara Al Mansoori | Arabic | Mall of the Emirates | Around 19:00 | Around 16:00 | Centre |
| Rahul Menon | Tamil | Burjuman | Around 21:00 | Around 18:00 | Back |
| James Whitfield | English | Mall of the Emirates | Around 20:00 | Around 16:30 | Back |

The displayed preferences come from past synthetic visits, with separate weekday/weekend windows. Open the account panel's cinema-visit history to explain them without putting raw data into the main conversation. Default weekends are Saturday/Sunday; an environment setting can change that.

## The 13 enhancement scenarios

Use a movie/showtime returned by the current environment rather than a hard-coded title that may no longer be bookable.

| # | Guest request / action | What to demonstrate |
|---|---|---|
| 1 | Rahul: “Suggest me a movie.” | One relevant available choice using Tamil, Burjuman and the relevant timing; no profile questionnaire |
| 2 | “Anything good between 4 and 6?” | Requested time window takes priority; useful results or a clearly labelled supported alternative |
| 3 | Rahul: “Show me an English movie.” | English overrides history; no silent return to Tamil |
| 4 | “Anything at City Centre Mirdif tonight?” | Mirdif overrides the usual cinema |
| 5 | James: “Anything around 10 tonight?” | Explicit 22:00 takes priority over usual timing |
| 6 | “Book 2 tickets for [available movie] at MOE around 7.” | No repeated known questions; editable held seats; optional snacks before one payment |
| 7 | Request a screening that has just started | Brief explanation and an actual next option; wait for selection before holding it |
| 8 | Sara: “Use my usual seats.” | Centre-seat suggestion visible; open the map and change seats with any price/category difference shown |
| 9 | Ask about the saved card's offer | Returned percentage/BOGO benefit, eligibility and application consent; recheck after card/quantity changes |
| 10 | End the conversation, then reopen on the same device | Offer continuation once; original valid expiry retained; expired choices preserved and new hold requires agreement |
| 11 | Ask for a weekday | Weekday timing influences the available recommendation |
| 12 | Ask for a weekend date | Separate weekend timing influences the recommendation |
| 13 | Repeat discovery, booking and continuation in English and Arabic voice | Same tool/state outcome, concise speech, natural interruption and transcript behavior |

Also repeat scenario 6 without a quantity: the assistant must ask how many rather than assuming one. After choosing snacks, check that ticket and food totals are in the same unpaid basket. Stop before Pay to demonstrate that food/seat agreement is not payment consent. Then complete a simulated payment deliberately through the secure control.

For continuation, test both a still-valid hold and a genuinely expired hold. Three minutes of inactivity must end only the conversation; it must not sign out, cancel a paid booking or renew seat expiry. The fixture order timer and the inactivity timer are independent.

## Existing journeys to retain

Exercise movie/cinema information, nearby cinemas with shared location, rating/age guidance when relevant, trailers, current booking lookup, cancellation/refund eligibility, confirmed cancellation, confirmed swap, loyalty balances, food after paid tickets, feedback, complaint and simulated human handover. Use current booking references from the signed-in account or authorized guest fixture rather than decorative example references.

Bank discounts and refunds must match the tool's result; no universal percentage or bank-policy claim should be inferred from an example. VOX Credit and SHARE remain available where supported. No new voucher system has been added. The checkout is simulated and clearly says no money is taken.

## Acceptance evidence

The [simulation suite](../packages/agent/coaching/SIMULATION-RUNBOOK.md) contains 17 short variants across these 13 groups. Provider simulations check conversation choices and tool arguments; they do not prove real UI state, real expiry or audio quality.

Record the code and agent version, each test/run ID, repeated outcomes, both hosting surfaces, mobile viewport/keyboard/seat-map checks, all three sign-ins, guest flow, actual inactivity/hold behavior and English/Arabic listening results. Do not present an unrun scenario as accepted.

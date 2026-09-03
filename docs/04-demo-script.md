# 04 — Demo script (Phase 1 + Phase 2 in ~25 minutes)

Run `pnpm db:seed` before the demo so every fixture is in its starting state. Open the demo page
(`http://localhost:5173` or the Lovable preview). Voice mode needs the ElevenLabs agent deployed
(`docs/02-runbook.md §6`); text mode works standalone.

## Demo accounts (all dummy)

| Persona | Identity | What they are for |
|---|---|---|
| Sara Al Mansoori | +971 50 123 4567 · PIN 1234 · SHARE Gold `SHR100234` | Logged-in journey, Arabic, personalised recommendations (family / animation history), booking `VXA7K2M` refundable, Share Points redemption |
| Rahul Menon | `SHR200877` · PIN 2468 | Cancellation edge cases: `RM3PQ9X` starts in ~20 min (inside cut-off), `RMB0GO1` bought with a bank offer (non-refundable), Malayalam/Hindi/Tamil history |
| James Whitfield | james.whitfield@example.com · PIN 9876 · Platinum | GOLD booking `JWG0LD7` with F&B (partial cancel keeps F&B), IMAX `JWIMX42` paid with VOX credit, swap to another showtime |
| Layla Haddad | guest, no account | Guest verification (last 4 digits `4455`), guest refund to original card only, `LHCANC01` already cancelled |
| Omar Khan | omar.khan@example.com · PIN 1111 · Blue | Group booking `OKGRP33` (partial cancellation of 1 of 3), `OK4DXC0` tickets already collected (not refundable) |
| Fatima Al Zaabi | +971 50 555 6677 · PIN 5555 | New member with no history → cold-start recommendations |

Cards (simulated Checkout): `4111 1111 1111 1111` approved · `4000 0000 0000 0002` declined.
Promo `MONDAY30` (Standard, Mondays) · Bank offer via ENBD BIN `455533` · Junior Club AED 25 tickets.

## Act 1 — Phase 1: "answers my questions and resolves my issues" (10 min)

1. **Movie information** — "What's on this weekend for kids?" → film cards with posters, ratings, experiences; "anything in Malayalam?"; "who's in it?" → cast/synopsis; "show me the trailer" → link button. Try a title that isn't showing → the agent suggests alternatives (fuzzy match + genre).
2. **Cinema information** — allow location in the browser → "which cinema is nearest?" → 3 nearest with distance and opening hours; "how do I get to the cinema inside Mall of the Emirates and where do I park?" → in-mall directions from the KB.
3. **Age restrictions** — "can my 6-year-old watch it in GOLD?" → rating rule + experience age rule verdict (differs by experience/cinema).
4. **General info / policies** — "what's your refund policy?", "I was charged but got no confirmation", "lost my ticket" → KB (RAG) answers grounded in the real site content.
5. **Promos & offers** — "any bank offers today?" → offer cards with eligibility (bank BIN, day, experience, tier) and remaining redemptions.
6. **Booking information** — "how do I book?" → steps + deep link to the session page on voxcinemas.com.
7. **Cancellation (happy path)** — log in as Sara → "cancel my booking for Saturday" → booking found, eligibility check (30-min cut-off, not collected, not bank offer), summary of refund amount and method (VOX credit or Share Points), **confirmation card** → confirm → action runs in the ledger, refund processed, receipt card. Say "cancel it again" → idempotent, no double refund.
8. **Cancellation (edge cases)** — as Rahul: `RM3PQ9X` is inside the cut-off → clear explanation, offer to swap; `RMB0GO1` bank offer → non-refundable per policy. As Layla (guest): agent asks for the last 4 digits of the phone before disclosing anything.
9. **Swap** — as James: "move my IMAX booking to tomorrow's later show" → price difference computed, seats re-allocated, old booking linked to new, one confirmation, compensation on failure.
10. **Transfer to agent** — get frustrated ("this is the third time, I want a person") → sentiment-triggered offer → transfer with a chat summary; the widget shows the human agent joining (simulated adapter, or a real Genesys agent when configured). The transcript continues in the same window.
11. **Reporting dashboard** — open `/dashboard`: conversations, success/drop-off, transfers, top topics, language split, CSAT, complaints; drill into the transcript of the conversation you just had.
12. **Voice & language** — switch to Arabic mid-conversation ("ممكن نكمل بالعربي؟") → the agent replies in Arabic, UI flips to RTL; VOX vocabulary (MAX, GOLD, Share Points, VOX Rewards) pronounced correctly.

## Act 2 — Phase 2: "the booking concierge that knows what I want" (12 min)

13. **Personalisation** — as Sara: "what should I watch?" → recommendations from history (family/animation, weekend, MOE), "the usual snacks?" → F&B suggestion from past orders. As Fatima → cold-start by popularity.
14. **Guided booking** — "book two tickets for that on Saturday evening in MAX at Mall of the Emirates" → sessions card → pick one → ticket types card (adult/child/student) → **seat map** (interactive; the agent can also pick "two together in the middle") → seats held in the order (10-min expiry shown).
15. **F&B information & pre-order** — "what combos do you have? anything vegan?" → menu cards filtered by dietary tags → "add the large combo" → order total updates live (SSE `order.updated`).
16. **Apply promos & offers** — "I have an ENBD card" → BOGO applied, order lines show the discount; try `MONDAY30` on a non-Monday → rejected with the reason; "use 500 Share Points" → points redeemed against the total.
17. **Payment** — "pay now" → payment sheet (tokenised in the widget, PAN never sent) → approved → booking confirmation card with **QR code**, reference, e-mail sent (dummy). Demo the declined card path once (`4000 0000 0000 0002`) → the order is preserved and the agent asks for another card.
18. **Booking status check** — "did my booking go through?" → the new booking appears (logged-in lookup); as a guest: "I booked but can't find the confirmation" → search by phone/email + last-4 verification.
19. **Multiple inputs while an action runs** — during payment or cancellation keep talking ("what time does it start again?") → the read answers immediately while the write action continues; results arrive via SSE and the agent reports them when done. Send the confirmation twice → one action.
20. **Complaint management** — "the sound was terrible in screen 4 yesterday" → complaint captured conversationally (cinema, date, booking, category), reference number issued, resolution offered or transfer.
21. **Customer feedback survey** — end the chat → 1–5 rating + comment stored; appears in the dashboard CSAT.
22. **Omni-channel** — the same agent id can be attached to a phone number / WhatsApp in ElevenLabs; the concierge API is channel-agnostic (`channel` on every session). Show the text-only widget vs voice widget to make the point.

## Recovery tips

- If seats show as taken, another order holds them — pick different seats or wait for the 10-min expiry.
- If a confirmation card expires (5 min), just ask again; the agent re-prepares the action.
- Reseed between runs: `pnpm db:seed`.

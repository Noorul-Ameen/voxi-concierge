# 04 — Demo script (Phase 1 + Phase 2 in ~25 minutes)

Run `pnpm db:seed` (or reseed production, `docs/06-live-environment.md`) before the demo so every fixture is in
its starting state. Open https://voxi-demo.up.railway.app (or `http://localhost:5173`). Voice mode needs the
ElevenLabs agent deployed (`docs/02-runbook.md §6`); text mode works standalone.

**Where to log in.** The public page deliberately shows no demo accounts. Sign in either with the **Log in**
button at the top-right of the page or the **Log in** button in the Voxi widget header — both open the same
sheet inside the widget: email, mobile number or member id + PIN. The page header then shows
"Hi <name> · Log out". Alternatively stay a guest and let Voxi ask for your details, or tell Voxi "log me in"
during the conversation (`login_customer` tool). The credentials below are only documented here and in
`docs/06-live-environment.md`.

## Demo accounts (all dummy)

| Profile | Identity | What they are for |
|---|---|---|
| 🇦🇪 Sara Al Mansoori — UAE | +971 50 123 4567 · PIN 1234 · SHARE Gold `SHR100234` · 2,450 pts · AED 120 credit | Arabic & English films, family history (KIDS shows, child tickets) → recommendations ask whether children are joining; saved ENBD Mastercard ·3845 (BOGO) and FAB Visa ·8258; booking `WXA7K2M` refundable; Share Points redemption |
| 🇮🇳 Rahul Menon — India | `SHR200877` · PIN 2468 · SHARE Silver · 620 pts · AED 35 credit | Tamil & Hindi films, late shows at Burjuman / Deira / Shindagha; saved ADCB Visa ·2211 (BOGO) and HSBC Visa ·6034; edge cases `WM3PQ9X` (cut-off), `WMB6GQ2` (bank offer, non-refundable), `WK4DXC9` (collected), `WKGRP33` (group of 3, partial cancel) |
| 🇬🇧 James Whitfield — UK | james.whitfield@example.com · PIN 9876 · SHARE Platinum · 8,800 pts · AED 450 credit | English films only, GOLD / IMAX / THEATRE at MOE, Yas Mall, Galleria; saved Mashreq Mastercard ·7712 (50%), CBD Visa ·0099 (50%), UK Visa ·5501 (no offer); `WJG8LD7` GOLD with F&B, `WJMX42R` IMAX swap demo |
| 👤 Guest (no account) | name, email, mobile + card at checkout | Guest checkout with the "Log in or create an account to view eligible offers and earn SHARE points" nudge, no bank offers; guest booking `WLHGST5` (phone ending 4455) for find-and-verify, `WLHCNC2` already cancelled |

Cards (simulated Checkout): `4111 1111 1111 1111` approved · `4000 0000 0000 0002` declined.
Promo `MONDAY30` (Standard, Mondays) · Bank offers are members-only, BOGO needs exactly 2 tickets and the same bank's card at payment (ENBD BIN `455533`/`521334`, ADCB `409255`, HSBC `424141`) · Junior Club AED 25 tickets · Payment methods: saved card, new card, Apple Pay, Samsung Pay (+ VOX credit / Share Points for members). Location: 📍 in the widget (GPS or pick an area) drives "near me".

## Act 1 — Phase 1: "answers my questions and resolves my issues" (10 min)

1. **Movie information** — "What's on this weekend for kids?" → film cards with posters, ratings, experiences; "anything in Malayalam?"; "who's in it?" → cast/synopsis; "show me the trailer" → link button. Try a title that isn't showing → the agent suggests alternatives (fuzzy match + genre).
2. **Cinema information** — allow location in the browser → "which cinema is nearest?" → 3 nearest with distance and opening hours; "how do I get to the cinema inside Mall of the Emirates and where do I park?" → in-mall directions from the KB.
3. **Age restrictions** — "can my 6-year-old watch it in GOLD?" → rating rule + experience age rule verdict (differs by experience/cinema).
4. **General info / policies** — "what's your refund policy?", "I was charged but got no confirmation", "lost my ticket" → KB (RAG) answers grounded in the real site content.
5. **Promos & offers** — "any bank offers today?" → offer cards with eligibility (bank BIN, day, experience, tier) and remaining redemptions.
6. **Booking information** — "how do I book?" → steps + deep link to the session page on voxcinemas.com.
7. **Cancellation (happy path)** — log in as Sara → "cancel my booking for Saturday" → booking found, eligibility check (30-min cut-off, not collected, not bank offer), summary of refund amount and method (VOX credit or Share Points), **confirmation card** → confirm → action runs in the ledger, refund processed, receipt card. Say "cancel it again" → idempotent, no double refund.
8. **Cancellation (edge cases)** — as Rahul: `WM3PQ9X` is inside the cut-off → clear explanation, offer to swap; `WMB6GQ2` bank offer → non-refundable per policy. As Layla (guest): agent asks for the last 4 digits of the phone before disclosing anything.
9. **Swap** — as James: "move my IMAX booking to tomorrow's later show" → price difference computed, seats re-allocated, old booking linked to new, one confirmation, compensation on failure.
10. **Transfer to agent** — get frustrated ("this is the third time, I want a person") → sentiment-triggered offer → transfer with a chat summary; the widget shows the human agent joining (simulated adapter, or a real Genesys agent when configured). The transcript continues in the same window.
11. **Reporting dashboard** — open `/dashboard`: conversations, success/drop-off, transfers, top topics, language split, CSAT, complaints; drill into the transcript of the conversation you just had.
12. **Voice & language** — switch to Arabic mid-conversation ("ممكن نكمل بالعربي؟") → the agent replies in Arabic, UI flips to RTL; VOX vocabulary (MAX, GOLD, Share Points, VOX Rewards) pronounced correctly.

## Act 2 — Phase 2: "the booking concierge that knows what I want" (12 min)

13. **Personalisation** — as Sara: "what should I watch?" → recommendations from history (family/animation, weekend, MOE), "the usual snacks?" → F&B suggestion from past orders. As a guest → popular titles, then two preference questions. "Suggest a movie" as Sara → Voxi asks whether children are joining before family picks; "any Hindi movies?" as Rahul → the explicit language wins over the profile.
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

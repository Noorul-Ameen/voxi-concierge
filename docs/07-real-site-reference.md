# 07 — Real VOX site reference (observed 4 Sep 2026, logged-in account)

What the live uae.voxcinemas.com actually shows a logged-in member, captured read-only from the
account area and the booking flow (no purchase was completed). This is the source of truth the demo's
structures, copy and dummy data are aligned to. Card numbers, names and balances below are masked or
illustrative.

## Brand & UI tokens
- Header bar VOX blue; primary CTAs are **magenta `#d40f7d`** ("Find Times And Book", "Book Tickets", "I Agree", "Redeem", "+" add buttons); dark charcoal footer. Body font *Effra* (fallback Tahoma/Arial).
- SHARE loyalty panel is **pink/magenta** (`SHARE` mark + Arabic شير).
- Booking summary bar (sticky, blue): film · showtime · cinema · seat count · CTA ("Confirm Seats" / "Skip") · running total.
- Order timer in the booking flow: ~**7 minutes** ("06:47" shown right after opening the seat plan).

## My Account
- Dashboard cards: **SHARE** (Points balance `105.8` = `10.58 AED`, i.e. **10 points = 1 AED**; SHARE ID, History, Find out more), **My Offers** (personal "For You" offers with image, validity date, "Book Now"), **Promotions**, **Wallet** (VOX credit balance, "Credits are valid for 90 days from the date added"), **Purchases** ("You have 18 past purchase(s)"), **Manage Details & Payment** (Personal details, Password, **Manage Saved Cards**, Link Guest Booking).
- Banner: "To request a refund on bookings made on the new VOX website or app, please call 600599905."
- Purchases list (NEW / PAST tabs): `Purchase date: 14 Aug 26 · Where: City Centre Deira · Vishwanath & Sons [Tamil] · 2:35pm Sun 16 Aug 2026 · Manage Booking`. Film titles carry the language in brackets.
- Receipt ("Your receipt" / "How to collect" tabs): **Purchase date, Venue, When, Order reference (7 chars, e.g. `WPGR737`), QR code, AMOUNT PAID 42.00 AED**.
- How to collect copy: "This is your ticket — Scan this QR code at the ticket podium and head straight into the cinema. No ticket queues. No print outs. No hassles. Your e-ticket holds all of the tickets purchased with this order. Make sure all of your guests have arrived before scanning the code." / "Food & Drinks — After you have selected 'Prepare my order' or scanned your QR code at a kiosk, the kitchen will start to prepare your order immediately. Your order collection number will display on the hot food collection screens at the Candy Bar."
- Saved cards: `MASTERCARD 5545 76XX XXXX 3845 (09/2027)` format — brand, first 6, last 4, expiry; delete needs a confirmation checkbox.

## Booking flow (per showtime `/booking/<cinemaId>-<sessionId>`)
Steps (accordion): **VOX MEMBERSHIP → CHOOSE SEATS → UPGRADES → FOOD & DRINKS → YOUR DETAILS → REVIEW & PAY**.
1. **Conditions of access** modal for rated films: "I understand this movie is rated 18+ — No persons under 18 years of age will be admitted." (PG13: "No persons under the age listed above will be admitted without an adult.") → *I Agree* / *Change Showtime*.
2. **Choose seats** comes first (tickets are priced per seat area, not chosen separately). Header block: title, rating · language · runtime, Venue, When, **Experience**, **Screen** ("Cinema 20", "VOX MAX 2"), Change Showtime; **Change Experience** chips when the same time exists in Standard / THEATRE / MAX.
   - Seat plan: curved **SCREEN** header, three seat blocks with aisles, rows lettered bottom-up (A nearest screen), seat ids `E-9`. Legend: **Unavailable** (×), **Your Seat** (magenta), **Regular** (blue), **Premium** (green), **Preferred View** (yellow). States in DOM: normal / sold / allocated.
   - "Your Selected Seats: x1 Regular – 46.00 AED per ticket". Observed prices: Standard (Deira) Regular **46**; MAX (Mirdif) Regular **52**, Premium **65**, Preferred View **70**.
3. **Apply upgrades** — "There are no ticket offers available for your selected showtime." (bank/ticket offers are session-specific).
4. **Food & drinks** — sticky category tabs: FOR YOU, POPCORN, HOT DRINKS, ORDERNOW, COMBOS, SODA, NACHOS, CINEMA SNACK, FRIES, COLD DRINKS, HOTDOGS, BURGERS, JUICES, DESSERT, CHOCOLATES, EXTRA, SNACKS, PASS. Cards: square image (`https://assets.voxcinemas.com/concessions/C_<id>.png|jpg`), name, price ("FROM 26.00 AED" when sizes exist), magenta "+". Size dialog e.g. Cheese popcorn: Large 26 / Regular 24 / Small 21 + quantity. Full Deira menu captured in `apps/scraper/out/fnb-menu-deira.json` (129 items with images).
5. **Your details** — "Your booking will be made as <name> (<email>) <phone>." (pre-filled for members).
6. **Review & pay**:
   - Tabs **BANK OFFERS** / **VOUCHER & PROMO**. Bank offers are per session and verified by card number **first 6–8 + last 4 digits** ("Apply Bank Offer"); logos at `https://assets.voxcinemas.com/offers/O_<Bank>.jpg`. On a Saturday Standard session: Mashreq 50% off, MAWARID 50% off, Citi 30% off, FAB "Weekend", CBD 50% off, RAKBANK 50% off. Voucher tab: "Your voucher or promo code" + Apply code.
   - **SHARE** block: "You could save 10.58 AED on this booking by applying your SHARE points!" with an AED amount input + **Redeem**.
   - Summary: Movie info ▾ (1 x Regular Ticket 46.00 AED ✎), **AMOUNT DUE**, VAT info ▾ (Total before VAT 43.81 · 5% VAT 2.19 · Amount due 46.00).
   - **Choose your payment method**: saved cards with brand logo (`5545 76XX XXXX 3845 (09/2027)`), **ADCB TouchPoints**, **Credit and Debit Cards** (new card: number, expiry, CVC, "Store card for future use?"), **Apple Pay**. "Payments are processed by checkout.com." PCI DSS badge. T&Cs + Refund/Exchange policy link.

## Offers & bank offers (public pages)
- `/promotions` → `/ticket-offer/summary`: VOX offers (Junior Club: AED 25 re-releases at VOX KIDS Fri–Sun), bank offers with banners, F&B promotions (Spider-Man pizza, Summer combo, Lay's Mango & Hot Spice popcorn, Messy burgers, wraps, sweet caramel nachos AED 35).
- Bank list: AAFAQ (BOGO), ADCB (BOGO), ADCB TouchPoints, Arab Bank (BOGO), CBD (50%), Citi (30% / BOGO), Deem (free ticket), Emirates Islamic, ENBD (BOGO), ENBD Flexi VISA, ENBD-SHARE, FAB-SHARE (free ticket), HSBC (BOGO + 25% F&B), Liv (BOGO), Mashreq (50%), MAWARID, RAKBANK (50% World card), Standard Chartered (free ticket per ticket), NBF, UAB.
- ENBD T&Cs structure (typical): eligible card types × experience matrix (2D/3D Standard regular / premium view / preferred view, KIDS, Premier at MOE & Yas, 4DX, NTN & Mercato premium view), **monthly limit 2–3 tickets**, "Log in as a VOX member — offer cannot be redeemed as a guest", verify card at the ticket-offer step and pay with the same card, 25% off single F&B items over AED 40, **tickets bought with a bank offer are non-refundable, non-exchangeable, non-transferable**, not combinable with other promotions.

## Showtimes presentation (film page)
- Day tabs: *Today · Tomorrow · Sun 06 Sep · Mon 07 Sep …*; then per cinema → per experience (Standard / GOLD / MAX / THEATRE / Premier / Kids / Premium) → time chips. Film titles show language in brackets for non-English prints.

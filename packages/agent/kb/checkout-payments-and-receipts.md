---
title: "Booking checkout, payment methods, bank-offer rules and receipts"
language: "en"
category: "booking"
source: "https://uae.voxcinemas.com (booking flow and My Account, observed September 2026)"
---

# Booking checkout, payment methods, bank-offer rules and receipts

This document contains reference information about the VOX website. In the Virtual Assistant demo, use the current tool results for actual seats, prices, offers and policy eligibility. Checkout is simulated: no real payment is taken, and the QR receipt appears in the widget. Do not claim an email, saved new card, food-preparation request or external delivery unless a tool confirms it. The available demo controls determine supported payment methods.

## Steps of an online booking
VOX Membership (log in or continue as guest) → Choose Seats → Upgrades (ticket offers for that showtime) → Optional Food & Drinks → Your Details → Review & Pay. The current booking's timer and backend expiry determine how long seats remain held. Reconnecting does not extend the hold. After expiry, keep the guest's choices and ask before checking availability and creating a fresh hold.

For rated films a "Conditions of access" notice must be accepted first: 18+ means no one under 18 is admitted; PG13/PG15 means children under that age are admitted only with an adult.

## Seats and ticket prices
Use the returned seat map for availability, seat categories and selection. The current order supplies the authoritative ticket types, quantities and total; map estimates are not a confirmed order price. State only the formatted amount returned by the tool. Do not reconstruct a price from a seat label, a general example or raw cents. Use the returned age rules and ticket types for child eligibility. Explain the VAT breakdown only when requested and returned by the tool.

## Food & drinks
The menu has category tabs for popcorn, drinks, combos and other cinema snacks. Use the actual menu for available items, modifiers and prices. Food is optional before payment: selected snacks join an active unpaid ticket basket in one checkout. Food bought after tickets are paid remains a separate purchase. This demo shows collection guidance on the receipt; adding or paying for food does not prove that a kitchen preparation request was sent. Only claim an external preparation or collection status when a tool confirms it.

## Review & Pay
- **Bank offers** tab: offers valid for that showtime are listed by bank. To apply one, log in as a VOX member (offers cannot be redeemed as a guest), enter the first 6–8 and last 4 digits of the card, then pay with the **same card**. Buy-one-get-one applies to exactly one pair: the order must hold exactly 2 eligible tickets. Most offers have a monthly limit of 2–3 tickets per card and cannot be combined with other promotions (one promotion per ticket). HSBC and Emirates NBD cards also give 25% off single food & drink items over AED 40. **Tickets bought with a bank offer are non-refundable, non-exchangeable and non-transferable.**
- **Voucher & promo** tab: enter a voucher or promo code.
- **SHARE points**: members can redeem points against the amount due. **10 points = AED 1.** The page shows "You could save AED X on this booking by applying your SHARE points".
- **Amount due** with a VAT info breakdown (total before VAT, 5% VAT, amount due).
- **Choose your payment method**: saved cards (shown masked, e.g. "MASTERCARD 5545 76XX XXXX 3845 (09/2027)"), ADCB TouchPoints, Credit and Debit Cards (with "Store card for future use"), Apple Pay, Samsung Pay. Guests check out with name, email, mobile and card only and cannot use bank offers. Payments are processed by checkout.com (PCI DSS). Members can also pay with VOX credit through the concierge.

## After payment — receipt and e-ticket
The Virtual Assistant demo receipt shows purchase date, venue, showtime, seats, the returned order reference, QR code and amount paid in the widget. Payment is simulated. Confirm the booking only after a successful payment result, and refer to the visible QR. The displayed receipt does not mean an email, SMS or external message was sent. Do not promise email delivery or an external resend without an explicit delivery result from a tool. Receipt collection guidance does not itself prove that tickets were scanned or food was prepared.

## Wallet and refunds
VOX credit is valid for 90 days from the date it is added. Refunds go back to the original card or, for members, to VOX credit or Share Points. Bank-offer bookings cannot be refunded or exchanged. To request a refund on a booking made on the website or app, call 600 599 905.

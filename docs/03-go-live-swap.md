# 03 — Go-live swap: from vista-mock to the real VOX / Vista APIs

The demo is built so that switching from the local mock to production is a **configuration change
plus a review of one module** (`packages/vista-client`). Nothing in the agent, the concierge tools,
the Action Ledger, the widget or the reporting layer references mock-specific behaviour.

## 1. What changes

| Layer | Demo | Production | Change |
|---|---|---|---|
| Vista base URL | `http://localhost:4010/vistatickets/vista/v2` | `https://api-prod.maflec.com/vistatickets/vista/v2` (dev: `api-dev.maflec.com`) | `VISTA_BASE_URL` |
| OAuth | mock `/v1/oauth/generate` | Apigee `/v1/oauth/generate?grant_type=client_credentials` | `VISTA_OAUTH_URL`, `VISTA_API_KEY`, `VISTA_CLIENT_SECRET` (base64 `apikey:secret`) |
| Network | — | Apigee IP whitelisting | egress IP of `concierge-api` / `worker` must be whitelisted |
| Reference data | seeded snapshot in Postgres, served by the mock | live OData | none — `VistaClient.cinemas/films/scheduledFilms/sessions/...` |
| Ordering | mock `Ticketing/*` | live `Ticketing/*` | none |
| Bookings | mock `RESTBooking.svc/*` | whichever VOX exposes (Connect `RESTBooking.svc`, Apigee `loyaltyalternate/v1/bookingsearch`, or CPI wrappers) | **review** `searchBookings/getBooking/refundBooking/cancelBooking` mappers |
| Loyalty | mock `RESTLoyalty.svc/*` | live loyalty API | **review** `validateMember/balances` |
| Offers Engine | mock `offers/v1/*` (invented schema — no real API exists yet) | Offers Engine when delivered | **review** `offers/offerEligibility` + `@voxi/domain/offers` benefit types |
| Customer profile | mock `customer/v1/*` | CDP / OneView profile API | **review** `customer/customerHistory` |
| Payment | simulated Checkout tokenisation | Checkout.com hosted/Frames tokenisation → `PaymentInfoCollection` | `PAYMENT_ADAPTER`, widget payment sheet swaps the tokeniser |
| Handover | simulated | Genesys Cloud Open Messaging | `HANDOVER_ADAPTER=genesys` + `GENESYS_*` |
| Reporting sink | local `conversations` tables | same, plus OneView export if required | optional exporter |

## 2. Contract fidelity that is already in place

- **Auth handshake**: Basic-secret → Bearer, `x-api-key` on every call, token cached and refreshed before expiry, one retry on the Apigee `keymanagement.service.access_token_expired` fault.
- **V1 semantics**: every V1 call returns HTTP 200; `VistaClient` inspects `Result` / `ExtendedResultCode` / `ErrorDescription` and raises `VistaClientError(kind="result")`. V2/OData errors use HTTP status. The concierge tools map both to user-facing explanations.
- **OData**: `$filter` (eq/ne/gt/ge/lt/le/and/or/not, `datetime'…'` literals, `substringof`, `tolower`, nested fields), `$select`, `$expand`, `$top`, `$skip`, `$orderby`, `$format=json` — the mock parses the exact expressions from the partner document (`IsComingSoon eq false and OpeningDate le datetime'…'`), so the queries the client issues are production queries.
- **Payload shapes**: `TicketTypes[{TicketTypeCode, Qty}]`, `SelectedSeats[{AreaCategoryCode, AreaNumber, RowIndex, ColumnIndex}]`, `Concessions[{ItemId, Quantity}]`, `PaymentInfoCollection[{PaymentValueCents, PaymentTenderCategory, PaymentToken|CardNumber…}]`, `UserSessionId` lifecycle with server-side order expiry.
- **Idempotency**: refunds/cancellations carry a client `Reference`; the Action Ledger guarantees at-most-once execution per confirmation even if Vista is slow and the customer repeats the request.

## 3. Swap procedure

1. Obtain Apigee credentials (dev first). Set `VISTA_BASE_URL`, `VISTA_OAUTH_URL`, `VISTA_API_KEY`, `VISTA_CLIENT_SECRET`, `VISTA_SALES_CHANNEL`, `VISTA_CLIENT_ID`. Whitelist the egress IP.
2. Run the Vista Postman collection (`infra/postman-vista-mock.json`) against the dev gateway by changing `vistaBase` / `oauthBase` / `basicSecret`. Every request that returns a shape difference identifies a mapper to adjust in `packages/vista-client/src/index.ts`.
3. Point `apps/vista-mock/test` fixtures at recorded dev responses if you want contract tests against real payloads (the tests are shape-based, not value-based).
4. Stop seeding reference data: the `reference.*` tables become a **read-through cache** of OData (`packages/db` seed → replace with a sync job calling `VistaClient.scheduledFilms({$expand: "Sessions"})` per cinema on a schedule; seat plans stay real-time as per Vista guidance).
5. Keep `commerce.*` (orders, holds, bookings) **only** for the concierge's own bookkeeping; Vista is the system of record. The ledger stores Vista ids (`VistaBookingId`, `VistaBookingNumber`, `VistaTransNumber`) on every action result.
6. Switch `PAYMENT_ADAPTER` to the Checkout implementation (tokenise in the widget, pass token in `PaymentInfoCollection`), `HANDOVER_ADAPTER=genesys`.
7. Redeploy the ElevenLabs agent (`pnpm --filter @voxi/agent agent:deploy`) — tool schemas are unchanged; only `CONCIERGE_PUBLIC_URL` differs per environment.
8. Confirm reCAPTCHA is disabled for the concierge client key on the ordering endpoints and that the client token has refund permission (Vista returns 403 otherwise).

## 4. Things to confirm with VOX IT before the swap

- The exact booking-search / refund / cancel endpoints (Connect vs Apigee vs CPI) and their ids (`BookingId` vs `BookingNumber` + `CinemaId`).
- Refund tender categories supported per channel (`EWALLET` VOX credit, `LOYALTY` Share Points, `CREDIT` original card) and whether partial refunds are enabled on the client key.
- Offers Engine contract (the demo schema: `{Id, Title, Type: percent|amount|bogo|fixed, Eligibility: {cinemas, experiences, cardBins, tiers, days}, RedemptionsRemaining}`).
- Customer profile / purchase history source for personalisation.
- Session/seat-plan caching policy and rate limits for the concierge client.

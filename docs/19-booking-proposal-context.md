# Explicit booking edits and verified food suggestions

The agent previously had to repeat every choice when changing one part of an unheld booking proposal. A missing time or experience could produce a different option. It also needed a separate menu lookup after applying an offer, which some conversations skipped. The new contracts reduce those dependencies while retaining customer consent before holds, food additions and payment.

## Proposal contract

`propose_booking` accepts `intent: initial` for a new plan, or `intent: edit` with the exact current `baseProposalRef`. An edit sends only the requested changes. The backend retains the other choices from the conversation's current proposal, resolves calendar dates, and checks the selected film, cinema, session, seats and prices again. The original requested time or window stays distinct from the actual suggested showtime, preventing successive nearest-time edits from drifting away from the request. A new successful revision returns a new `proposalRef`.

The ElevenLabs tool requires `intent` and sends the literal capability header `x-voxi-proposal-context: explicit`. The header is not authentication or consent. The API rejects a capability-marked request with missing intent. Older callers without the marker retain their existing initial-proposal behavior; omitted intent does not silently turn into an edit.

Supplied `childAges` belong only to the current party. A changed child count requires matching ages again. The backend checks the current film rating and experience using the shared admission evaluator and enforces the existing child-fare age band. Missing or inconsistent details prevent acceptance; they do not justify inferring ages from purchase history. Accompanying-person requirements remain conditions to communicate, not facts automatically proven by an age result.

For explicit-context proposals, revisions are scoped to the conversation identity and authentication generation. Stale references, account changes, conflicting exact-session inputs, concurrent edits and a hold completed during an edit are rejected. Acceptance still uses the expiring signed proposal token and checks current availability, price and child admission. Repeating a successful acceptance may return the existing unchanged order; it must not create another hold or extend its expiry. A completed, cancelled, expired or replaced order cannot be revived by replay. Legacy stateless tokens retain their existing short-lived behavior; these new bindings are not applied retroactively, and a legacy token cannot supersede a current explicit proposal.

`get_session_context.data.currentProposal` exposes the current `proposalRef`, choices and quote status without acceptance tokens or internal identity/locking fields. Widget quantity and edit actions carry the displayed proposal reference. Normal proposal metadata updates cannot overwrite a newer revision.

## Successful offer result

An applied offer on an unpaid ticket basket without food may return `snackSuggestions` in the completed action result. A ready result contains current-cinema menu items, available usual-item IDs and suggested quantities, plus `purchaseRequiresConsent: true`. Popular items are not described as a past purchase. The existing history format records item occurrences, so suggested quantities are not a guarantee of the exact quantities bought previously.

The optional menu/history lookup is bounded. A lookup or cache error returns `status: unavailable` while retaining the successful discount. Offer removal, failed application and baskets that already contain food do not generate another food suggestion. Enrichment does not open a menu or add food. The existing usual-food cache is synchronized to the returned selection so a later consented repeat request cannot use an older cached menu.

The agent can name verified items directly from a ready result, offer them once and honor refusal. It must wait for consent before adding the displayed items, then present the actual final amount before payment.

## Release and verification

Deploy the compatible API, worker and widget before promoting the new native tool contract. When copying the native tool, merge the reviewed capability header into its existing headers and preserve its authentication, URL and other transport settings. Do not publish a generated fixture configuration.

Validation covers proposal merging and identity boundaries, acceptance races and replay, new admission checks, optional food failures, stale usual selections, consent and the existing journey controls. Isolated native English/Arabic conversations must also exercise the final authored instructions and schemas. Local tests or mocked conversations alone do not establish that a release has reached Railway or the live ElevenLabs agent.

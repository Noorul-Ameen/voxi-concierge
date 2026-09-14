import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Cards, proposalQuantityInput } from "../components/Cards";
import { actionContext } from "./widget-state";

it("quantity completion edits only the displayed verified draft and cannot silently start a different show", () => {
  const proposal = { sessionKey: "old-show", childTickets: 1, ticketQuantity: null, totalCents: null };
  expect(proposalQuantityInput(proposal, { proposalRef: "current-ref" }, 2)).toEqual({ intent: "edit", baseProposalRef: "current-ref", tickets: 2 });
  expect(proposalQuantityInput(proposal, {}, 2)).toEqual({ intent: "initial", sessionKey: "old-show", childTickets: 1, tickets: 2 });
});
it("a missing-age proposal cannot expose an enabled hold action, while acknowledgements retain the ref but exclude tokens", () => {
  const data = { proposalRef: "verified-ref", proposalToken: "secret-token", needs: "child_age", admission: { verified: false, childAges: [] }, proposal: { filmTitle: "Film", ticketQuantity: 2, totalCents: 8500, selectedSeats: [] } };
  const html = renderToStaticMarkup(<Cards ui={{type:"booking_proposal",items:[data.proposal],meta:{proposalRef:data.proposalRef,needs:data.needs}}} lang="en" act={{say:()=>{},command:async()=>({ok:true}),openLink:()=>{},playTrailer:()=>{}}}/>);
  expect(html).toMatch(/disabled=""[^>]*>Hold these seats/);
  const acknowledgement = JSON.parse(actionContext("proposal.preview", { ok: true, data }));
  expect(acknowledgement.state).toMatchObject({ proposalRef: "verified-ref", needs: "child_age", admission: { verified: false } });
  expect(JSON.stringify(acknowledgement)).not.toContain("secret-token");
});

import type { SimulationMock } from "./simulations.js";

/** Explicit proposal response fixtures for the known G/PG family scenarios only.
 * Ages are supplied by each authored scenario, never inferred from a customer profile.
 */
export function proposalEvidence(
  proposal: Record<string, any>,
  proposalRef: string,
  childAges: number[],
  proposalToken?: string,
  needs = "proposal_acceptance",
) {
  const rating = proposal.rating;
  if (!["G", "PG", "PG13", "PG15"].includes(rating))
    throw new Error("Use an explicit restricted-rating fixture");
  if (["GOLD", "THEATRE"].includes(proposal.experience))
    throw new Error("Use an explicit experience-admission fixture");
  const guidanceAge = rating === "PG13" ? 13 : rating === "PG15" ? 15 : null;
  const missingAges = (proposal.childTickets ?? 0) !== childAges.length;
  const admission = {
    rating,
    experience: proposal.experience,
    childAges,
    children: childAges.map((age) => ({
      rule: { code: rating, known: true, minimumAge: 0, provisional: false, guidanceAge },
      checkedChildAge: age,
      filmAllowed: true,
      allowed: true,
      minimumAge: 0,
      restrictedExperience: false,
      experienceBlocked: false,
      guidanceAge,
      filmAccompanimentRequired: guidanceAge != null && age <= guidanceAge,
    })),
    verified: !missingAges,
  };
  const actualNeeds = missingAges ? "child_age" : needs;
  const token = !missingAges && needs === "proposal_acceptance" ? proposalToken : undefined;
  return {
    data: {
      proposal,
      proposalRef,
      admission,
      needs: actualNeeds,
      ...(token ? { proposalToken: token } : {}),
    },
    ui: {
      type: "booking_proposal",
      items: [proposal],
      meta: {
        proposalRef,
        admission,
        needs: actualNeeds,
        editable: true,
        ...(token ? { proposalToken: token } : {}),
      },
      actions: [
        ...(token ? [{ label: "Hold these seats", value: "proposal:accept" }] : []),
        { label: "Change choices", value: "proposal:edit" },
      ],
    },
  };
}

/** Native array matching is deliberately list-shaped; scalar7 is not [7]. */
export function guardProposalAges(mocks: SimulationMock[], expected: number[]): SimulationMock[] {
  const pattern = `\\[\\s*${expected.join("\\s*,\\s*")}\\s*\\]`;
  return [
    {
      parameter_conditions: [
        { path: "childAges", eval: { type: "regex", pattern: `^(?!(?:${pattern})$).+` } },
      ],
      is_error: true,
      mock_result: JSON.stringify({
        ok: false,
        error: {
          code: "UNEXPECTED_SIMULATION_PARAMETER",
          message: "Child ages do not match the ages supplied in this scenario.",
          retryable: false,
        },
      }),
    },
    {
      parameter_conditions: [
        { path: "intent", eval: { type: "exact", expected_value: "initial" } },
        { path: "baseProposalRef", eval: { type: "regex", pattern: ".+" } },
      ],
      is_error: true,
      mock_result: JSON.stringify({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Initial proposals cannot include a base reference.",
          retryable: false,
        },
      }),
    },
    ...mocks,
  ];
}

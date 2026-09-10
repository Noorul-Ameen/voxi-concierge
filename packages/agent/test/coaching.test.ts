import { describe, expect, it } from "vitest";
import { assessResponse } from "../src/coaching.js";

describe("offline conversation coaching", () => {
  it("flags redundant questions and formal language", () => {
    expect(
      assessResponse({
        text: "Certainly. Which cinema would you prefer?",
        modality: "text",
        known: { cinema: true },
      }).flags,
    ).toEqual(expect.arrayContaining(["formal_tone", "asks_known_information"]));
  });
  it("flags repetition and multiple questions", () => {
    const text = "How many tickets? Which cinema?";
    expect(assessResponse({ text, modality: "voice", previousResponses: [text] }).flags).toEqual(
      expect.arrayContaining(["repeated_response", "multiple_questions"]),
    );
  });
  it("compares spoken prices and references against supplied tool facts", () => {
    expect(
      assessResponse({
        text: "Booked WABC123 for AED 50.",
        modality: "text",
        confirmedFacts: { amountsCents: [9200], bookingReferences: [] },
      }).flags,
    ).toEqual(["unsupported_amount", "unsupported_booking_reference"]);
    expect(
      assessResponse({
        text: "That comes to 92 dirhams.",
        modality: "voice",
        confirmedFacts: { amountsCents: [9200] },
      }).flags,
    ).toEqual([]);
  });
  it("leaves a short contextual acknowledgement alone", () => {
    expect(
      assessResponse({ text: "Two centre seats together — you can change them here.", modality: "voice" }),
    ).toEqual({ flags: [], needsReview: false });
  });
});

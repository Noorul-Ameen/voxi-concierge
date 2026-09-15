import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/index.js";

describe("conversation style requirements", () => {
  const prompt = systemPrompt();
  it("keeps delivery markers out of replies and speaks values naturally", () => {
    expect(prompt).toMatch(/Never write delivery, pacing or emotion markers/);
    expect(prompt).toMatch(/\[excited\], \[happy\], \[sad\], \[laughs\]/);
    expect(prompt).toMatch(/eighty-two dirhams eighty fils/);
    expect(prompt).toMatch(/natural delivery, unchanged value/);
    // The value itself must still come from the tool result, never from arithmetic.
    expect(prompt).toMatch(/never recalculate it/);
  });
  it("asks for a human, unscripted tone without banning the history mention", () => {
    expect(prompt).toMatch(/upbeat, easy and human, never formal, scripted or corporate/);
    expect(prompt).not.toMatch(/"Based on your preferences" and "Would you like me to proceed\?"/);
    expect(prompt).toMatch(/Based on what you usually watch/);
  });
  it("forbids re-reading confirmed details across every journey", () => {
    expect(prompt).toMatch(/film, cinema, time, seats, price, card or reference/);
    expect(prompt).toMatch(/including cancellation, exchange and payment investigation/);
    expect(prompt).toMatch(/Do not re-ask for a detail the guest already gave/);
  });
  it("states the guest and member rules in the shared prompt so every procedure inherits them", () => {
    expect(prompt).toMatch(/Based on what you usually watch/);
    expect(prompt).toMatch(/Once per conversation is enough/);
    expect(prompt).toMatch(/A guest has no stored history/);
    expect(prompt).toMatch(/one short question bundling the two details/);
    expect(prompt).toMatch(/Never run a questionnaire/);
  });
});

import { describe, expect, it } from "vitest";
import { sessionResumeMs } from "./Concierge";

describe("saved widget session resume window", () => {
  it("lets a guest pick a booking back up for 30 minutes, then starts fresh", () => {
    expect(sessionResumeMs({ loggedIn: false })).toBe(30 * 60000);
    expect(sessionResumeMs({})).toBe(30 * 60000);
  });
  it("keeps a signed-in member's session for 6 hours", () => {
    expect(sessionResumeMs({ loggedIn: true })).toBe(6 * 60 * 60000);
  });
});

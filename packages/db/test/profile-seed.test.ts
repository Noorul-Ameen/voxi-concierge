import { describe, expect, it } from "vitest";
import { loyaltyAccounts, loyaltyLedger } from "../src/schema/customer.js";
import { DEMO_PROFILE_PATTERNS, demoHistoryId } from "../src/seed/profile-update.js";

describe("bounded demo profile seed", () => {
  it("uses distinct IDs for every customer, day type and visit", () => {
    const ids = DEMO_PROFILE_PATTERNS.flatMap((profile) =>
      ["weekday", "weekend"].flatMap((day) =>
        Array.from({ length: 6 }, (_, visit) =>
          demoHistoryId(profile.id, day as "weekday" | "weekend", visit),
        ),
      ),
    );
    expect(new Set(ids).size).toBe(36);
    expect(ids.every((id) => id.length <= 32)).toBe(true);
  });
  it("maps fractional points to numbers without changing whole-fils wallet entries", () => {
    expect(loyaltyAccounts.sharePointsBalance.mapFromDriverValue("105.8")).toBe(105.8);
    expect(loyaltyLedger.delta.mapFromDriverValue("-105.8")).toBe(-105.8);
    expect(loyaltyLedger.delta.mapFromDriverValue("1058.0")).toBe(1058);
    expect(loyaltyAccounts.sharePointsBalance.mapToDriverValue(105.8)).toBe("105.8");
  });
});

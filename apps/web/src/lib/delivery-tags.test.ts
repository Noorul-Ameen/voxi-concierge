import { describe, expect, it } from "vitest";
import { stripDeliveryTags } from "./delivery-tags";

describe("delivery tags", () => {
  it("removes emotion and delivery markers from displayed text", () => {
    expect(stripDeliveryTags("[excited] You're booked!")).toBe("You're booked!");
    expect(stripDeliveryTags("Seats held [laughs] — shall we pay?")).toBe("Seats held — shall we pay?");
    expect(stripDeliveryTags("[Happy]تم الحجز")).toBe("تم الحجز");
    expect(stripDeliveryTags("تمام [متحمس] نكمل؟")).toBe("تمام نكمل؟");
  });
  it("keeps text that is not a delivery marker", () => {
    expect(stripDeliveryTags("[widget] Seat hold expires in 2 minutes.")).toBe("[widget] Seat hold expires in 2 minutes.");
    expect(stripDeliveryTags("Your seats are G11–G12")).toBe("Your seats are G11–G12");
    expect(stripDeliveryTags("Screen [MAX] is upstairs")).toBe("Screen [MAX] is upstairs");
  });
});

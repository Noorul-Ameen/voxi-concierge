import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.js";

describe("account password verification", () => {
  it("stores salted hashes and accepts only the exact password", async () => {
    const password = "local-fixture-password";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toContain(password);
    expect(first).not.toBe(second);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword("wrong-password", first)).toBe(false);
    expect(await verifyPassword(undefined, first)).toBe(false);
    expect(await verifyPassword("", first)).toBe(false);
  });
  it("never accepts missing, malformed or unsupported stored credentials", async () => {
    for (const hash of [null, "1234", "scrypt$bad$hash", "sha256$bad$hash"])
      expect(await verifyPassword("local-fixture-password", hash)).toBe(false);
  });
});

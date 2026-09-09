import { expect, it } from "vitest";
import { assertLocalTestDatabase } from "../../../infra/test-db-guard.js";

it("refuses remote, missing and application databases before test mutations", () => {
  for (const value of [
    "",
    "postgres://test:password@db.example.com/voxi_test",
    "postgres://test:password@localhost/voxi",
    "https://localhost/voxi_test",
  ])
    expect(() => assertLocalTestDatabase(value)).toThrow();
  expect(assertLocalTestDatabase("postgres://test:password@127.0.0.1:55432/voxi_test")).toContain(
    "/voxi_test",
  );
});

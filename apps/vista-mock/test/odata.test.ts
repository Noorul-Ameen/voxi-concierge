import { describe, expect, it } from "vitest";
import { applyQuery, compileFilter } from "../src/odata.js";

const rows = [
  { ID: "1", Name: "City Centre Deira", CurrencyCode: "AED", Seats: 10, Open: true, OpeningDate: "2026-09-01T00:00:00", Nested: { X: "a" } },
  { ID: "2", Name: "Riyadh Park", CurrencyCode: "SAR", Seats: 5, Open: false, OpeningDate: "2026-10-01T00:00:00", Nested: { X: "b" } },
];
describe("OData $filter", () => {
  it("eq / and / or / not / parentheses", () => {
    expect(rows.filter(compileFilter("CurrencyCode eq 'AED'"))).toHaveLength(1);
    expect(rows.filter(compileFilter("CurrencyCode eq 'AED' or CurrencyCode eq 'SAR'"))).toHaveLength(2);
    expect(rows.filter(compileFilter("not (CurrencyCode eq 'AED') and Seats lt 6"))).toHaveLength(1);
    expect(rows.filter(compileFilter("Open eq true"))).toHaveLength(1);
  });
  it("datetime literals (both documented spellings)", () => {
    expect(rows.filter(compileFilter("OpeningDate gt DATETIME '2026-09-15T00:00:00'"))).toHaveLength(1);
    expect(rows.filter(compileFilter("OpeningDate gt datetime'2026-09-15T00:00:00'"))).toHaveLength(1);
  });
  it("string functions and nested fields", () => {
    expect(rows.filter(compileFilter("substringof('deira', Name)"))).toHaveLength(1);
    expect(rows.filter(compileFilter("startswith(Name,'Riy')"))).toHaveLength(1);
    expect(rows.filter(compileFilter("Nested/X eq 'b'"))).toHaveLength(1);
  });
  it("escaped quotes", () => {
    expect([{ Name: "O'Neil" }].filter(compileFilter("Name eq 'O''Neil'"))).toHaveLength(1);
  });
  it("throws on garbage", () => {
    expect(() => compileFilter("CinemaId eq")).toThrow();
  });
});
describe("$select/$top/$skip/$orderby/$expand", () => {
  it("applies in order", () => {
    const out = applyQuery(rows, { orderby: "Seats desc", top: "1", select: "ID,Name" });
    expect(out).toEqual([{ ID: "1", Name: "City Centre Deira" }]);
  });
  it("strips expandable navigation properties unless expanded", () => {
    expect(applyQuery(rows, {}, { expandable: ["Nested"] })[0]).not.toHaveProperty("Nested");
    expect(applyQuery(rows, { expand: "Nested" }, { expandable: ["Nested"] })[0]).toHaveProperty("Nested");
  });
});

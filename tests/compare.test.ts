import { describe, expect, it } from "vitest";
import { answerAgrees, compareResult, normalizeCell } from "../eval/compare.js";

const unordered = { columns: ["country_code", "net"], ordered: false, keyColumns: [0] };
const ranked = { columns: ["country_code", "drop"], ordered: true, keyColumns: [0] };
const expected = { columns: ["country_code", "net"], rows: [["US", "1000"], ["DE", "500"]] };

describe("the trusted comparison", () => {
  it("matches the same rows in any order for an unordered answer", () => {
    expect(compareResult(unordered, expected, { columns: ["c", "n"], rows: [["DE", 500], ["US", "1000.00"]] }).exact).toBe(true);
  });
  it("detects wrong units", () => {
    expect(compareResult(unordered, expected, { columns: ["c", "n"], rows: [["US", "10.00"], ["DE", "5.00"]] }).exact).toBe(false);
  });
  it("detects a missing row", () => {
    expect(compareResult(unordered, expected, { columns: ["c", "n"], rows: [["US", "1000"]] }).exact).toBe(false);
  });
  it("detects a duplicated row", () => {
    expect(compareResult(unordered, expected, { columns: ["c", "n"], rows: [["US", "1000"], ["DE", "500"], ["DE", "500"]] }).exact).toBe(false);
  });
  it("detects a fanned-out amount", () => {
    expect(compareResult(unordered, expected, { columns: ["c", "n"], rows: [["US", "2000"], ["DE", "500"]] }).exact).toBe(false);
  });
  it("requires the order of a ranking, including the tie rule", () => {
    const e = { columns: ["c", "d"], rows: [["CA", "5"], ["FR", "5"], ["US", "3"]] };
    expect(compareResult(ranked, e, { columns: ["c", "d"], rows: [["CA", "5"], ["FR", "5"], ["US", "3"]] }).exact).toBe(true);
    expect(compareResult(ranked, e, { columns: ["c", "d"], rows: [["FR", "5"], ["CA", "5"], ["US", "3"]] }).exact).toBe(false);
  });
  it("refuses a truncated result", () => {
    expect(compareResult(unordered, expected, { columns: ["c", "n"], rows: expected.rows, truncated: true }).exact).toBe(false);
  });
  it("refuses a different column count", () => {
    expect(compareResult(unordered, expected, { columns: ["c"], rows: [["US"], ["DE"]] }).exact).toBe(false);
  });
  it("normalizes exact integers only", () => {
    expect(normalizeCell("00042")).toBe("42");
    expect(normalizeCell("42.000")).toBe("42");
    expect(normalizeCell(42)).toBe("42");
    expect(normalizeCell("42.5")).toBe("42.5");
    expect(normalizeCell(null)).toBe("null");
  });
  it("checks that a one-value answer states the value", () => {
    const one = { rows: [["123456"]] };
    expect(answerAgrees("Net revenue was 123,456 cents.", one)).toBe(true);
    expect(answerAgrees("Net revenue was $1,234.56.", one)).toBe(true);
    expect(answerAgrees("Net revenue was $1,999.00.", one)).toBe(false);
    expect(answerAgrees("anything", expected)).toBeNull();
  });
});

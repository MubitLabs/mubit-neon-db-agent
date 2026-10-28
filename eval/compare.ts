import type { Shape } from "./references.js";

export type Comparison = {
  exact: boolean;
  reason: string;
  expectedRows: number;
  actualRows: number;
  columnNames: { expected: string[]; actual: string[] };
};

/** Integer cents stay exact: "123", 123, "123.0" and "123.00" are the same value; anything else compares as text. */
export function normalizeCell(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v).trim();
  const m = /^(-?\d+)(?:\.0+)?$/.exec(s);
  if (m) return String(BigInt(m[1]!));
  if (/^-?\d+\.\d+$/.test(s)) return String(Number(Number(s).toFixed(6)));
  return s;
}

function sortRows(rows: string[][], keys: number[]): string[][] {
  const order = keys.length > 0 ? keys : rows[0]?.map((_, i) => i) ?? [];
  return [...rows].sort((a, b) => {
    for (const k of order) {
      const x = a[k] ?? "";
      const y = b[k] ?? "";
      if (x !== y) return x < y ? -1 : 1;
    }
    return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
  });
}

/**
 * Compares the agent's declared result table with the reference by position: same column count, same rows. Unordered
 * answers are sorted by the shape's key columns first; ordered (ranking) answers must match row for row.
 */
export function compareResult(shape: Shape, expected: { columns: string[]; rows: unknown[][] }, actual: { columns: string[]; rows: unknown[][]; truncated?: boolean }): Comparison {
  const base = { expectedRows: expected.rows.length, actualRows: actual.rows.length, columnNames: { expected: expected.columns, actual: actual.columns } };
  if (actual.truncated) return { exact: false, reason: "the result was truncated", ...base };
  if (actual.columns.length !== expected.columns.length) {
    return { exact: false, reason: `expected ${expected.columns.length} columns, got ${actual.columns.length}`, ...base };
  }
  const e = expected.rows.map((r) => r.map(normalizeCell));
  const a = actual.rows.map((r) => r.map(normalizeCell));
  if (e.length !== a.length) return { exact: false, reason: `expected ${e.length} rows, got ${a.length}`, ...base };
  const ee = shape.ordered ? e : sortRows(e, shape.keyColumns);
  const aa = shape.ordered ? a : sortRows(a, shape.keyColumns);
  for (let i = 0; i < ee.length; i++) {
    if (JSON.stringify(ee[i]) !== JSON.stringify(aa[i])) {
      return { exact: false, reason: `row ${i + 1} differs: expected ${JSON.stringify(ee[i])}, got ${JSON.stringify(aa[i])}`, ...base };
    }
  }
  return { exact: true, reason: "exact match", ...base };
}

/** For a one-value answer, the answer text must state that value (as cents, or as dollars with two decimals). */
export function answerAgrees(text: string, expected: { rows: unknown[][] }): boolean | null {
  if (expected.rows.length !== 1 || expected.rows[0]!.length !== 1) return null;
  const cents = normalizeCell(expected.rows[0]![0]);
  if (!/^-?\d+$/.test(cents)) return null;
  const numbers = (text.replace(/(\d),(?=\d{3})/g, "$1").match(/-?\d+(?:\.\d+)?/g) ?? []).map((n) => n);
  const dollars = (Number(cents) / 100).toFixed(2);
  return numbers.some((n) => n === cents || n === dollars || normalizeCell(n) === cents);
}

import { TEMPLATES, type Params, type SchemaVersion } from "./references.js";

export type Split = "learning" | "development" | "final" | "diagnostic";
export type EvalCase = {
  id: string;
  templateId: string;
  intent: string;
  split: Split;
  schemaVersion: SchemaVersion;
  environmentId: string;
  params: Params;
  question: string;
};

export const CASES_VERSION = "acme-cases-2026-10-28.1";

const MONTHS = ["2026-08", "2026-09", "2026-07", "2026-03", "2025-12", "2026-05", "2026-06", "2026-02"];

function previous(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function paramsFor(templateIndex: number, slot: number): Params {
  const month = MONTHS[(templateIndex + slot) % MONTHS.length]!;
  const safeMonth = month === "2025-10" ? "2025-11" : month; // the drop template needs a previous month in range
  return { month: safeMonth, prevMonth: previous(safeMonth), limit: 3 + ((templateIndex + slot) % 3) };
}

/**
 * 12 templates × 5 parameter slots = 60 distinct questions. Each (template, parameters) pair lands in exactly one
 * split: 30 learning, 10 development, 20 final (10 on v1, 10 on v2). Slot 5 renders 10 paired diagnostic intents on
 * both schema versions; those are isolated runs and never training material.
 */
export function buildCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  const finals: EvalCase[] = [];
  TEMPLATES.forEach((t, ti) => {
    for (let slot = 0; slot < 5; slot++) {
      const params = paramsFor(ti, slot);
      let split: Split;
      if (slot <= 1 || (slot === 2 && ti < 6)) split = "learning";
      else if ((slot === 2 && ti >= 6) || (slot === 3 && ti < 4)) split = "development";
      else split = "final";
      const c: EvalCase = {
        id: `${t.id}-${slot}`,
        templateId: t.id,
        intent: t.intent,
        split,
        schemaVersion: "v1",
        environmentId: "demo-v1",
        params,
        question: t.question(params),
      };
      if (split === "final") finals.push(c);
      else cases.push(c);
    }
  });
  // Alternate the 20 final questions between v1 and v2 so both phases cover every intent.
  finals.forEach((c, i) => {
    if (i % 2 === 1) {
      c.schemaVersion = "v2";
      c.environmentId = "demo-v2";
    }
    cases.push(c);
  });
  TEMPLATES.slice(0, 10).forEach((t, ti) => {
    const params = paramsFor(ti, 5);
    for (const version of ["v1", "v2"] as const) {
      cases.push({
        id: `${t.id}-diag-${version}`,
        templateId: t.id,
        intent: t.intent,
        split: "diagnostic",
        schemaVersion: version,
        environmentId: version === "v1" ? "demo-v1" : "demo-v2",
        params,
        question: t.question(params),
      });
    }
  });
  return cases;
}

export function templateOf(c: EvalCase) {
  const t = TEMPLATES.find((x) => x.id === c.templateId);
  if (!t) throw new Error(`unknown template ${c.templateId}`);
  return t;
}

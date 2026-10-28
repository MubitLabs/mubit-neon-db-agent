import { describe, expect, it } from "vitest";
import { decodeLesson, encodeLesson, selectApplicable } from "../src/mubit.js";
import type { Lesson, Scope } from "../src/types.js";

const scope = (over: Partial<Scope> = {}): Scope => ({
  tenantId: "acme-demo",
  databaseId: "acme-commerce",
  environmentId: "demo-v1",
  calibrationNamespace: "demo",
  semanticVersion: "2026-10-acme-1",
  schemaHash: "aaaa",
  schemaVersion: "v1",
  ...over,
});

const lesson = (id: string, kind: Lesson["kind"], over: Partial<Lesson> = {}, scopeOver: Partial<Scope> = {}): Lesson => ({
  id,
  kind,
  text: `lesson ${id}`,
  scope: scope(scopeOver),
  evidenceIds: ["q_1"],
  verification: "verified",
  identifiers: kind === "semantic" ? [] : ["orders", "orders.gross_cents"],
  source: "mubit",
  ...over,
});

const v1Ids = new Set(["orders", "orders.gross_cents", "orders.refund_cents"]);
const v2Ids = new Set(["orders", "orders.subtotal_cents", "refunds", "refunds.amount_cents"]);

describe("lesson scope", () => {
  it("round-trips through the text header", () => {
    const l = lesson("les_1", "schema", { supersedesId: "les_0" });
    const back = decodeLesson(encodeLesson(l), scope(), "remote-1")!;
    expect(back).toMatchObject({ id: "les_1", kind: "schema", supersedesId: "les_0", remoteId: "remote-1", identifiers: l.identifiers });
    expect(back.scope.schemaHash).toBe("aaaa");
  });
  it("ignores text without a header", () => {
    expect(decodeLesson("just a fact", scope())).toBeNull();
  });
  it("isolates namespaces and databases", () => {
    const got = selectApplicable(
      [lesson("a", "semantic"), lesson("b", "semantic", {}, { calibrationNamespace: "eval-arm-b" }), lesson("c", "semantic", {}, { databaseId: "other" })],
      scope(),
      v1Ids,
    );
    expect(got.map((l) => l.id)).toEqual(["a"]);
  });
  it("drops v1 schema mappings on v2 and keeps semantics", () => {
    const got = selectApplicable([lesson("map-v1", "schema"), lesson("meaning", "semantic")], scope({ schemaHash: "bbbb", schemaVersion: "v2" }), v2Ids);
    expect(got.map((l) => l.id)).toEqual(["meaning"]);
  });
  it("drops procedures that name columns the schema no longer has", () => {
    const got = selectApplicable([lesson("proc-v1", "procedure"), lesson("proc-v2", "procedure", { identifiers: ["orders.subtotal_cents"] })], scope({ schemaHash: "bbbb" }), v2Ids);
    expect(got.map((l) => l.id)).toEqual(["proc-v2"]);
  });
  it("lets a lesson retire another only where it applies itself", () => {
    const newer = lesson("map-v2", "schema", { supersedesId: "map-v1" }, { schemaHash: "bbbb", schemaVersion: "v2" });
    expect(selectApplicable([lesson("map-v1", "schema"), newer], scope(), v1Ids).map((l) => l.id)).toEqual(["map-v1"]);
    expect(selectApplicable([lesson("map-v1", "schema"), newer], scope({ schemaHash: "bbbb" }), v2Ids).map((l) => l.id)).toEqual(["map-v2"]);
  });
  it("uses only verified lessons and respects the count budget", () => {
    const many = Array.from({ length: 9 }, (_, i) => lesson(`s${i}`, "semantic"));
    expect(selectApplicable([...many, lesson("cand", "semantic", { verification: "unverified" })], scope(), v1Ids)).toHaveLength(5);
  });
});

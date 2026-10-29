import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createMubitClient } from "../src/mubit.js";
import type { Lesson } from "../src/types.js";

const lesson: Lesson = {
  id: "les_1",
  kind: "schema",
  text: "a lesson",
  scope: { tenantId: "acme-demo", databaseId: "acme-commerce", environmentId: "demo-v1", calibrationNamespace: "demo", semanticVersion: "s", schemaHash: "h", schemaVersion: "v1" },
  evidenceIds: [],
  verification: "verified",
  identifiers: [],
  source: "mubit",
};

describe("the calibration client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the idempotency key with a lesson and with an outcome, so Mubit applies a resend once", async () => {
    const bodies = new Map<string, Record<string, unknown>>();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      bodies.set(new URL(url).pathname, JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    });
    const client = createMubitClient(loadConfig({ MUBIT_API_KEY: "mbt_test", CALIBRATION_BACKEND: "mubit" }));
    await client.remember(lesson, "lesson:les_1");
    await client.report({ runId: "run_1", verification: "verified", source: "reviewer", evidenceIds: [] }, "outcome:run_1:verified");
    expect(bodies.get("/v2/control/ingest")).toMatchObject({ idempotency_key: "lesson:les_1" });
    expect(bodies.get("/v2/control/outcome")).toMatchObject({ idempotency_key: "outcome:run_1:verified" });
  });
});

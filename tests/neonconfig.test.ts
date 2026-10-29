import { join } from "node:path";
import { loadConfigFromFile } from "@neon/config/v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FUNCTION_ENV } from "../scripts/function-env.js";
import { TRIGGER_PATH } from "../src/http.js";

/** Loads neon.ts with @neon/config's loader, as `neon deploy` does. Every Function setting is set unless overridden. */
async function neonConfig(overrides: Record<string, string | undefined> = {}) {
  for (const key of FUNCTION_ENV) vi.stubEnv(key, key in overrides ? overrides[key] : `value-of-${key}`);
  return (await loadConfigFromFile({ path: join(process.cwd(), "neon.ts") })).config;
}

describe("neon.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("deploys dbagent from dist/fn with the Function's settings, and a schedule trigger on the delivery route", async () => {
    const config = await neonConfig();
    const fn = config.functions?.dbagent;
    expect(fn).toMatchObject({ name: "dbagent", source: "./dist/fn", bundler: "none" });
    expect(Object.keys(fn?.env ?? {}).sort()).toEqual([...FUNCTION_ENV].sort());
    expect(fn?.env?.MUBIT_API_KEY).toBe("value-of-MUBIT_API_KEY");
    expect(config.triggers).toEqual({ "learning-deliveries": { type: "schedule", function: "dbagent", cron: "*/15 * * * *", functionPath: TRIGGER_PATH } });
  });

  it("refuses a missing setting instead of sending it empty", async () => {
    await expect(neonConfig({ MUBIT_API_KEY: undefined })).rejects.toThrow(/MUBIT_API_KEY/);
  });

  it("refuses an empty setting, which would delete the live one", async () => {
    await expect(neonConfig({ MUBIT_API_KEY: "" })).rejects.toThrow(/MUBIT_API_KEY/);
    await expect(neonConfig({ DEMO_ACCESS_TOKEN: "" })).rejects.toThrow(/DEMO_ACCESS_TOKEN/);
  });
});

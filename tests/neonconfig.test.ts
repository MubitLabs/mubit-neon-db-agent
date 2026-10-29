import { afterEach, describe, expect, it, vi } from "vitest";
import { FUNCTION_ENV } from "../scripts/function-env.js";
import { TRIGGER_PATH } from "../src/http.js";

/** Evaluates neon.ts the way `neon deploy` does, with every Function setting set except `missing`. */
async function neonConfig(missing?: string) {
  for (const key of FUNCTION_ENV) vi.stubEnv(key, key === missing ? undefined : `value-of-${key}`);
  return (await import("../neon.js")).default;
}

describe("neon.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
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
    await expect(neonConfig("MUBIT_API_KEY")).rejects.toThrow(/MUBIT_API_KEY/);
  });
});

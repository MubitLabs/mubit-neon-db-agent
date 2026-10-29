import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadDotEnv } from "../src/config.js";
import { loadKeychainSecrets } from "../src/secrets.js";
import { FUNCTION_ENV } from "./function-env.js";

/**
 * Applies neon.ts to a Neon branch with `neon deploy`: the Function `dbagent` (the prebuilt dist/fn) and its schedule
 * trigger. Function settings come from .env (and the keychain for MUBIT_API_KEY); nothing secret is printed. The
 * Function's own DATABASE_URL (the branch it runs on, agent-control) is its control database.
 *   npm run deploy -- [--branch agent-control] [--plan]
 * --plan prints what the deploy would change (`neon config plan`) and changes nothing.
 */
loadDotEnv(join(process.cwd(), ".env"));
loadKeychainSecrets();
const argv = process.argv.slice(2);
const branch = argv.includes("--branch") ? argv[argv.indexOf("--branch") + 1]! : "agent-control";
const plan = argv.includes("--plan");
const projectId = process.env.NEON_PROJECT_ID;
if (!projectId) throw new Error("NEON_PROJECT_ID is not set (run prepare --neon first)");

// An empty value would erase the live setting, so a missing or empty one stops the deploy before Neon sees it.
const missing = FUNCTION_ENV.filter((k) => !process.env[k]);
if (missing.length) throw new Error(`missing settings: ${missing.join(", ")}`);
const scrub = (s: string) =>
  s.replace(/postgres(ql)?:\/\/\S+/gi, "<connection>").replace(/mbt_[A-Za-z0-9_-]+/g, "mbt_…").replace(/\b[a-f0-9]{32,}\b/g, "<secret>");
const neon = (args: string[]) =>
  execFileSync("neon", [...args, "--project-id", projectId, "--branch", branch], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });

try {
  // neon.ts reads the settings from this process's environment, which the CLI inherits (.env plus the keychain key).
  // --no-env-pull keeps the CLI from writing the branch's variables into .env after the deploy.
  const out = neon(plan ? ["config", "plan", "--env", ".env"] : ["deploy", "--env", ".env", "--no-env-pull"]);
  console.log(scrub(out).trim().split("\n").slice(-40).join("\n"));
} catch (error) {
  const e = error as { stdout?: string; stderr?: string; message: string };
  console.error(scrub(`${e.stdout ?? ""}\n${e.stderr ?? ""}`).trim().slice(-2_000) || scrub(e.message));
  process.exit(1);
}
if (plan) process.exit(0);

const fn = JSON.parse(neon(["functions", "get", "dbagent", "-o", "json"])) as { invocation_url?: string; active_deployment?: { status?: string } };
console.log(`dbagent on ${branch}: ${fn.invocation_url ?? "(no URL yet)"} ${fn.active_deployment?.status ?? ""}`);
type Trigger = { name?: string; enabled?: boolean; function_path?: string; next_run_at?: string | null; schedule?: { cron?: string } };
const listed = JSON.parse(neon(["triggers", "list", "-o", "json"])) as Trigger[] | { triggers?: Trigger[] };
for (const t of Array.isArray(listed) ? listed : (listed.triggers ?? [])) {
  console.log(`trigger ${t.name}: ${t.enabled ? "enabled" : "disabled"}, cron ${t.schedule?.cron ?? "?"}, path ${t.function_path ?? "/"}, next run ${t.next_run_at ?? "none"}`);
}

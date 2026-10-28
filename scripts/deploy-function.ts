import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadDotEnv } from "../src/config.js";
import { loadKeychainSecrets } from "../src/secrets.js";

/**
 * Deploys dist/fn to a Neon branch as the Function `dbagent`. Function settings come from .env (and the keychain for
 * MUBIT_API_KEY) and go to the Neon CLI as arguments; nothing secret is printed. The Function's own DATABASE_URL (the
 * branch it runs on, agent-control) is its control database.
 *   npm run deploy -- [--branch agent-control]
 */
loadDotEnv(join(process.cwd(), ".env"));
loadKeychainSecrets();
const argv = process.argv.slice(2);
const branch = argv.includes("--branch") ? argv[argv.indexOf("--branch") + 1]! : "agent-control";
const projectId = process.env.NEON_PROJECT_ID;
if (!projectId) throw new Error("NEON_PROJECT_ID is not set (run prepare --neon first)");

const keys = [
  "AGENT_DATABASE_URL_DEMO_V1",
  "AGENT_DATABASE_URL_DEMO_V2",
  "MUBIT_API_KEY",
  "BASE_MODEL",
  "CALIBRATION_BACKEND",
  "CALIBRATION_NAMESPACE",
  "MUBIT_SESSION_METADATA",
  "DEMO_ACCESS_TOKEN",
];
const missing = keys.filter((k) => !process.env[k]);
if (missing.length) throw new Error(`missing settings: ${missing.join(", ")}`);
const envArgs = keys.flatMap((k) => ["--env", `${k}=${process.env[k]}`]);
const scrub = (s: string) => s.replace(/postgres(ql)?:\/\/\S+/gi, "<connection>").replace(/mbt_[A-Za-z0-9_-]+/g, "mbt_…");

try {
  const out = execFileSync(
    "neon",
    ["functions", "deploy", "dbagent", "--project-id", projectId, "--branch", branch, "--src", "dist/fn", "--no-bundle", "--runtime", "nodejs24", ...envArgs],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
  );
  console.log(scrub(out).trim().split("\n").slice(-12).join("\n"));
} catch (error) {
  const e = error as { stdout?: string; stderr?: string; message: string };
  console.error(scrub(`${e.stdout ?? ""}\n${e.stderr ?? ""}`).trim().slice(-2_000) || scrub(e.message));
  process.exit(1);
}
const info = JSON.parse(execFileSync("neon", ["functions", "get", "dbagent", "--project-id", projectId, "--branch", branch, "-o", "json"], { encoding: "utf8" })) as Record<string, unknown>;
const fn = (info.function ?? info) as { invocation_url?: string; status?: string };
console.log(`dbagent on ${branch}: ${fn.invocation_url ?? "(no URL yet)"} ${fn.status ?? ""}`);

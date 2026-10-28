import { readFileSync } from "node:fs";
import { z } from "zod";
import { MODES, type Mode } from "./types.js";
import registryJson from "../environments.json" with { type: "json" };

/** Runtime limits. */
export const LIMITS = {
  maxTurns: 8,
  maxToolCalls: 12,
  maxFailedQueries: 2,
  maxSchemaRefreshes: 1,
  requestDeadlineMs: 45_000,
  modelTimeoutMs: 20_000,
  maxModelRetries: 2,
  maxRows: 200,
  maxToolOutputBytes: 64 * 1024,
  statementTimeoutMs: 3_000,
  lockTimeoutMs: 500,
  idleInTransactionMs: 5_000,
  maxConcurrentRuns: 3,
  recallMaxLessons: 5,
  recallTokenBudget: 800,
  maxLessonsPerRun: 3,
  maxBodyBytes: 32 * 1024,
} as const;

const RegistrySchema = z.object({
  tenantId: z.string().min(1),
  logicalDatabaseId: z.string().min(1),
  environments: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,64}$/),
        label: z.string(),
        readerUrlEnv: z.string(),
        evalUrlEnv: z.string(),
        modes: z.array(z.enum(MODES)),
      }),
    )
    .min(1),
});

export type EnvironmentConfig = {
  id: string;
  label: string;
  readerUrl: string | undefined;
  evalUrl: string | undefined;
  modes: Mode[];
};

export type Config = {
  tenantId: string;
  logicalDatabaseId: string;
  environments: EnvironmentConfig[];
  controlDatabaseUrl: string | undefined;
  mubitApiKey: string | undefined;
  mubitConnectUrl: string;
  mubitApiOrigin: string;
  baseModel: string | undefined;
  responseFormat: "json_schema" | "json_object" | "none";
  sendSessionMetadata: boolean;
  calibrationBackend: "mubit" | "off";
  calibrationNamespace: string;
  mubitAgentId: string;
  demoAccessToken: string | undefined;
  reportingClock: string;
};

const CalibrationBackend = z.enum(["mubit", "off"]);
const ResponseFormat = z.enum(["json_schema", "json_object", "none"]);

/** Reads the environment once. Secrets stay in this object; nothing here is ever logged. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const registry = RegistrySchema.parse(registryJson);
  const connect = env.MUBIT_CONNECT_URL ?? "https://api.mubit.ai/openai/v1";
  const connectUrl = new URL(connect);
  if (connectUrl.protocol !== "https:" && connectUrl.hostname !== "localhost" && connectUrl.hostname !== "127.0.0.1") {
    throw new Error("MUBIT_CONNECT_URL must be https");
  }
  const namespace = env.CALIBRATION_NAMESPACE ?? "demo";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) throw new Error("CALIBRATION_NAMESPACE must be lower-case letters, digits and dashes");
  return {
    tenantId: registry.tenantId,
    logicalDatabaseId: registry.logicalDatabaseId,
    environments: registry.environments.map((e) => ({
      id: e.id,
      label: e.label,
      readerUrl: env[e.readerUrlEnv],
      evalUrl: env[e.evalUrlEnv],
      modes: e.modes,
    })),
    controlDatabaseUrl: env.CONTROL_DATABASE_URL ?? env.DATABASE_URL,
    mubitApiKey: env.MUBIT_API_KEY,
    mubitConnectUrl: connect.replace(/\/+$/, ""),
    mubitApiOrigin: (env.MUBIT_API_ORIGIN ?? connectUrl.origin).replace(/\/+$/, ""),
    baseModel: env.BASE_MODEL,
    responseFormat: ResponseFormat.parse(env.RESPONSE_FORMAT ?? "json_schema"),
    sendSessionMetadata: (env.MUBIT_SESSION_METADATA ?? "on") !== "off",
    calibrationBackend: CalibrationBackend.parse(env.CALIBRATION_BACKEND ?? "mubit"),
    calibrationNamespace: namespace,
    mubitAgentId: env.MUBIT_AGENT_ID ?? "acme-db-agent",
    demoAccessToken: env.DEMO_ACCESS_TOKEN,
    reportingClock: "2026-10-01T00:00:00Z",
  };
}

export function environmentById(config: Config, id: string): EnvironmentConfig | undefined {
  return config.environments.find((e) => e.id === id);
}

/** Loads KEY=VALUE lines from a file into process.env without overriding what is already set. */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const key = m[1]!;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value;
  }
}

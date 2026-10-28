import OpenAI from "openai";
import { loadConfig } from "./config.js";
import { TOOLS } from "./prompt.js";
import { MODEL_ANSWER_JSON_SCHEMA } from "./types.js";

/**
 * The setup check (`npm run check`): the model route, tool calling with a fixed response format, and the runtime
 * calibration endpoints. It never prints a key. Its model calls send x-middleware-record: metadata, so they never
 * become training data.
 */
export async function checkSetup(): Promise<void> {
  const config = loadConfig();
  const out = (k: string, v: unknown) => console.log(`${k.padEnd(28)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
  out("route", config.mubitConnectUrl);
  out("model", config.baseModel ?? "BASE_MODEL not set");
  out("calibration backend", config.calibrationBackend);
  out("mubit key", config.mubitApiKey ? `set (${config.mubitApiKey.slice(0, 11)}…)` : "missing");
  if (!config.mubitApiKey) return;
  const auth = { authorization: `Bearer ${config.mubitApiKey}` };

  const models = await fetch(`${config.mubitConnectUrl}/models`, { headers: auth });
  const list = (await models.json().catch(() => ({}))) as { data?: { id: string }[] };
  out("GET /models", `${models.status} ${models.headers.get("x-middleware-request-id") ?? ""} ${list.data?.length ?? 0} models`);
  if (config.baseModel) out("BASE_MODEL listed", Boolean(list.data?.some((m) => m.id === config.baseModel)));

  if (config.baseModel) {
    const client = new OpenAI({ apiKey: config.mubitApiKey, baseURL: config.mubitConnectUrl, maxRetries: 0, timeout: 30_000 });
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: "You explore a database with tools. Reply with the JSON answer format when done." },
      { role: "user", content: "Call list_tables once, then answer: status answered, text naming the tables, empty resultQueryId." },
    ];
    const format = { type: "json_schema" as const, json_schema: { name: "answer", strict: true, schema: MODEL_ANSWER_JSON_SCHEMA as unknown as Record<string, unknown> } };
    const first = await client.chat.completions
      .create({ model: config.baseModel, messages, tools: TOOLS, tool_choice: "auto", response_format: format }, { headers: { "x-middleware-record": "metadata" } })
      .withResponse();
    const call = first.data.choices[0]?.message.tool_calls?.[0];
    out("tool call", `${call?.type === "function" ? call.function.name : "none"} (served ${first.data.model}, ${first.response.headers.get("x-middleware-request-id")})`);
    if (call) {
      messages.push(first.data.choices[0]!.message as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ tables: [{ name: "orders" }, { name: "customers" }] }) });
      const second = await client.chat.completions
        .create({ model: config.baseModel, messages, tools: TOOLS, tool_choice: "auto", response_format: format }, { headers: { "x-middleware-record": "metadata" } })
        .withResponse();
      const content = second.data.choices[0]?.message.content ?? "";
      let parsed = false;
      try {
        JSON.parse(content);
        parsed = true;
      } catch {
        parsed = false;
      }
      out("final JSON after tool", `${parsed ? "parsed" : "NOT JSON"} (${second.response.headers.get("x-middleware-request-id")}, usage ${JSON.stringify(second.data.usage ?? null)})`);
    }
  }

  const health = await fetch(`${config.mubitApiOrigin}/v2/core/health`, { headers: auth }).catch(() => null);
  out("calibration health", health ? `${health.status}` : "unreachable");
  const ctx = await fetch(`${config.mubitApiOrigin}/v2/loop/context`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ task: "acme-db-agent", budget_tokens: 200, preview: true }),
  }).catch(() => null);
  if (ctx) {
    const body = (await ctx.json().catch(() => ({}))) as Record<string, unknown>;
    out("calibration context read", `${ctx.status} keys ${Object.keys(body).slice(0, 8).join(",")} units ${Array.isArray(body.units) ? body.units.length : "-"} ${body.empty_reason ? `empty_reason ${String(body.empty_reason)}` : ""}${body.error ? ` error ${JSON.stringify(body.error).slice(0, 160)}` : ""}`);
  } else out("calibration context read", "unreachable");
  out("training data", "interactive calls are recorded in full as one Mubit task; evaluation calls send x-middleware-record: metadata");
  out("evaluation isolation", "x-middleware-record: metadata on evaluation calls");
}

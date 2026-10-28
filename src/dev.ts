import { createServer } from "node:http";
import { join } from "node:path";
import { loadDotEnv } from "./config.js";
import { loadKeychainSecrets } from "./secrets.js";

/** Local server for the same HTTP API the Neon Function runs: `npm run dev`, then call http://localhost:8787. */
loadDotEnv(join(process.cwd(), ".env"));
loadKeychainSecrets();
const { default: fn } = await import("./function.js");

const port = Number(process.env.PORT ?? 8787);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(`http://localhost:${port}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
    ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
  });
  const response = await fn.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`mubit-neon-db-agent on http://localhost:${port}`));

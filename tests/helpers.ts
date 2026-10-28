import { join } from "node:path";
import { loadDotEnv } from "../src/config.js";

/**
 * Database tests run against the local Postgres that `npm run demo:prepare -- --local` built. Their connection strings
 * live in .env.test (copied from .env after a local prepare). Without it, those tests are skipped.
 */
loadDotEnv(join(process.cwd(), ".env.test"));

export const LOCAL = {
  reader: process.env.AGENT_DATABASE_URL_DEMO_V1,
  readerV2: process.env.AGENT_DATABASE_URL_DEMO_V2,
  owner: process.env.EVAL_DATABASE_URL_DEMO_V1,
  ownerV2: process.env.EVAL_DATABASE_URL_DEMO_V2,
  control: process.env.CONTROL_DATABASE_URL,
};

export const hasDb = Boolean(LOCAL.reader && LOCAL.owner && LOCAL.control && /127\.0\.0\.1|localhost/.test(LOCAL.control ?? ""));

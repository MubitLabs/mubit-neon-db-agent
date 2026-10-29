import { defineConfig } from "@neon/config/v1";
import { FUNCTION_ENV } from "./scripts/function-env.js";

/**
 * The Neon Function and its schedule trigger, applied by `npm run deploy` (`neon deploy --env .env`).
 * - dbagent ships the prebuilt dist/fn (scripts/build-function.ts): the bundle plus the SQL parser's WebAssembly file.
 * - Its settings are read from .env, and MUBIT_API_KEY from the keychain. A missing or empty setting stops the
 *   deploy: an empty value would erase the live one.
 * - learning-deliveries posts to /triggers/deliveries every 15 minutes, and the Function sends any delivery still
 *   pending.
 */
// `KEY=` in the env file is an empty value. Neon would store it and delete the live setting, so it stops here, whether
// the deploy runs through `npm run deploy` or a bare `neon deploy --env .env`.
const empty = FUNCTION_ENV.filter((key) => process.env[key] === "");
if (empty.length) throw new Error(`empty Function settings: ${empty.join(", ")} (an empty value would delete the live one)`);

export default defineConfig({
  functions: {
    dbagent: {
      name: "dbagent",
      source: "./dist/fn",
      bundler: "none",
      env: {
        AGENT_DATABASE_URL_DEMO_V1: process.env.AGENT_DATABASE_URL_DEMO_V1!,
        AGENT_DATABASE_URL_DEMO_V2: process.env.AGENT_DATABASE_URL_DEMO_V2!,
        MUBIT_API_KEY: process.env.MUBIT_API_KEY!,
        BASE_MODEL: process.env.BASE_MODEL!,
        CALIBRATION_BACKEND: process.env.CALIBRATION_BACKEND!,
        CALIBRATION_NAMESPACE: process.env.CALIBRATION_NAMESPACE!,
        MUBIT_SESSION_METADATA: process.env.MUBIT_SESSION_METADATA!,
        DEMO_ACCESS_TOKEN: process.env.DEMO_ACCESS_TOKEN!,
      },
    },
  },
  triggers: {
    "learning-deliveries": {
      type: "schedule",
      function: "dbagent",
      cron: "*/15 * * * *",
      functionPath: "/triggers/deliveries",
    },
  },
});

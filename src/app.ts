import { environmentById, loadConfig, type Config, type EnvironmentConfig } from "./config.js";
import { poolFor } from "./db.js";
import { createMubitClient, type Capabilities, type MubitClient } from "./mubit.js";
import { initSqlPolicy } from "./sqlpolicy.js";
import { createStore, type Store } from "./store.js";

/** The process-wide dependencies, built once and reused across requests. */
export type App = {
  config: Config;
  store: Store;
  mubit: MubitClient;
  capabilities: () => Promise<Capabilities>;
  environment: (id: string) => EnvironmentConfig | undefined;
  readerPool: (env: EnvironmentConfig) => ReturnType<typeof poolFor>;
  evalPool: (env: EnvironmentConfig) => ReturnType<typeof poolFor>;
};

let app: Promise<App> | null = null;

export function getApp(): Promise<App> {
  app ??= build();
  return app;
}

async function build(): Promise<App> {
  await initSqlPolicy();
  const config = loadConfig();
  if (!config.controlDatabaseUrl) throw new Error("CONTROL_DATABASE_URL (or DATABASE_URL) is not set");
  // A delivery sender holds a connection while Mubit answers (store.sendNextDelivery). Four leave room for runs while
  // the trigger and a verdict request each send.
  const controlPool = poolFor(config.controlDatabaseUrl, 4);
  const store = createStore(controlPool);
  const mubit = createMubitClient(config);
  let caps: Promise<Capabilities> | null = null;
  return {
    config,
    store,
    mubit,
    capabilities: () => (caps ??= mubit.capabilities().catch((e) => {
      caps = null;
      throw e;
    })),
    environment: (id) => environmentById(config, id),
    readerPool: (env) => {
      if (!env.readerUrl) throw new Error(`environment ${env.id} has no reader connection configured`);
      return poolFor(env.readerUrl, 3);
    },
    evalPool: (env) => {
      const url = env.evalUrl ?? env.readerUrl;
      if (!url) throw new Error(`environment ${env.id} has no evaluation connection configured`);
      return poolFor(url, 2);
    },
  };
}

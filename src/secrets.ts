import { execFileSync } from "node:child_process";

/**
 * Local convenience only (macOS): when MUBIT_API_KEY is unset, read it from the keychain item named by
 * MUBIT_KEYCHAIN_ITEM (default mubit-neon-demo-key). The value goes into this process's environment and is never
 * printed. Deployed Functions get their secrets from `neon deploy --env`.
 */
export function loadKeychainSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (env.MUBIT_API_KEY || process.platform !== "darwin") return;
  const item = env.MUBIT_KEYCHAIN_ITEM ?? "mubit-neon-demo-key";
  try {
    const value = execFileSync("security", ["find-generic-password", "-s", item, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (value) env.MUBIT_API_KEY = value;
  } catch {
    // no keychain item: the run reports MUBIT_API_KEY as missing
  }
}

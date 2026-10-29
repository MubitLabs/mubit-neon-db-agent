/** The Function's settings: the keys neon.ts declares, read from .env (MUBIT_API_KEY from the keychain). */
export const FUNCTION_ENV = [
  "AGENT_DATABASE_URL_DEMO_V1",
  "AGENT_DATABASE_URL_DEMO_V2",
  "MUBIT_API_KEY",
  "BASE_MODEL",
  "CALIBRATION_BACKEND",
  "CALIBRATION_NAMESPACE",
  "MUBIT_SESSION_METADATA",
  "DEMO_ACCESS_TOKEN",
] as const;

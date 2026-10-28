import { getApp } from "./app.js";
import { handle } from "./http.js";

/**
 * The Neon Function entry point: a default export with fetch(request) returning a Response (Node.js 24 runtime).
 * The app and its pools are built once per isolate and reused across requests.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const app = await getApp();
    return handle(request, app);
  },
};

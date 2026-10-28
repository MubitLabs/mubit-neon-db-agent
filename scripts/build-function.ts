import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

/**
 * Builds the Neon Function as a prebuilt directory: dist/fn/index.mjs (the app and the PostgreSQL parser, bundled)
 * plus dist/fn/libpg-query.wasm (the parser's WebAssembly binary, which cannot live inside the bundle).
 * Deploy it with `npm run deploy` (scripts/deploy-function.ts), which uses `neon functions deploy --no-bundle`.
 */
rmSync("dist/fn", { recursive: true, force: true });
mkdirSync("dist/fn", { recursive: true });
await build({
  entryPoints: ["src/function.ts"],
  outfile: "dist/fn/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["pg-native"],
  // The parser's Emscripten loader reads __dirname to find its .wasm file, so the ESM bundle provides it.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);",
  },
  legalComments: "none",
  logLevel: "warning",
});
// The parser's JavaScript is in the bundle; only its WebAssembly binary ships beside it.
cpSync("node_modules/libpg-query/wasm/libpg-query.wasm", "dist/fn/libpg-query.wasm");
writeFileSync("dist/fn/package.json", JSON.stringify({ type: "module", private: true }, null, 2));
console.log("built dist/fn (index.mjs + libpg-query.wasm)");

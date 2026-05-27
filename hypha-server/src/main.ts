/**
 * hypha-server entry point.
 *
 * M1 adds auth routes (login/session/logout/jwks) and a statics route on top
 * of M0's /health probe.
 *
 * Future milestones:
 *   - Reverse-proxy for /sync/* to the spawned node-adapter.js (M2)
 *   - Volume persistence for sessions + signing keys (M3)
 *   - Hardened deploy config + headless smoke test (M4)
 *
 * See docs/hypha/phase-1-plan.md section 4 for the architecture.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const here = fileURLToPath(new URL(".", import.meta.url));
// dist/main.js → repo root: ../../../ from compiled location; from src/main.ts
// (tsx) it is one level up from src/. Both paths land on the same workspace
// root, so resolve relative to two-up from the running file.
const repoRoot = resolve(here, "..", "..");
const staticDir = process.env.HYPHA_STATIC_DIR ?? resolve(repoRoot, "static");

const config = await loadConfig();
const app = await buildApp({ config, staticDir });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`hypha-server listening on ${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

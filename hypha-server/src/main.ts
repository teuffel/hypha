/**
 * hypha-server entry point.
 *
 * M2 adds the db-sync child process + reverse proxy on top of M1's auth +
 * statics surface.
 *
 * Startup ordering:
 *   1. Load config (env-var parsing, ephemeral key generation).
 *   2. Build app with auth/statics/proxy routes registered.
 *   3. Spawn node-adapter; wait for it to print the readiness line.
 *   4. Start listening on the hypha-server port.
 *
 * Doing (3) before (4) means the moment hypha-server accepts a client
 * request the upstream proxy target is already live; a /sync/* request
 * does not race the child boot.
 *
 * Future milestones:
 *   - Volume-backed persistence for sessions + signing keys (M3)
 *   - Hardened deploy config + headless smoke test (M4)
 *
 * See docs/hypha/phase-1-plan.md section 4 for the architecture.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DbSyncRunner } from "./db-sync-runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
// dist/main.js → repo root: ../../../ from compiled location; from src/main.ts
// (tsx) it is one level up from src/. Both paths land on the same workspace
// root, so resolve relative to two-up from the running file.
const repoRoot = resolve(here, "..", "..");
const staticDir = process.env.HYPHA_STATIC_DIR ?? resolve(repoRoot, "static");
const adapterPath =
  process.env.HYPHA_DB_SYNC_ADAPTER_PATH ??
  resolve(repoRoot, "deps/db-sync/worker/dist/node-adapter.js");

const config = await loadConfig();

const syncUpstreamUrl = `http://127.0.0.1:${config.dbSyncInternalPort}`;
const jwksUrl = `http://127.0.0.1:${config.port}/auth/jwks`;

// Phase 1.5 plugin marketplace + R2 CDN proxy upstreams. Both endpoints are
// CORS-enabled and the browser could call them directly; we proxy to cache
// the responses (V1 probe showed 2/3 cold R2 fetches timing out, and the
// GitHub-API-wrapped R2 endpoint is rate-limited 60/hr unauthenticated).
//
// Env overrides exist so the headless Playwright suite can point both
// upstreams at a local fixture server and stay hermetic in CI.
const pluginMarketUpstream =
  process.env.HYPHA_PLUGIN_MARKET_UPSTREAM ??
  "https://raw.githubusercontent.com/logseq/marketplace/master";
const pluginCdnUpstream =
  process.env.HYPHA_PLUGIN_CDN_UPSTREAM ??
  "https://plugins.logseq.io/r2";

const app = await buildApp({
  config,
  staticDir,
  syncUpstreamUrl,
  pluginUpstream: { marketBase: pluginMarketUpstream, cdnBase: pluginCdnUpstream },
});

const runner = new DbSyncRunner({
  adapterPath,
  port: config.dbSyncInternalPort,
  dataDir: config.dataDir,
  jwtIssuer: config.jwtIssuer,
  jwtAudience: config.jwtAudience,
  jwksUrl,
  logger: app.log,
});

// Graceful shutdown: stop accepting new connections first, then kill the
// child. Both POSIX signals trigger the same handler.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    app.log.info(`received ${sig}; shutting down`);
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, "fastify close failed");
    }
    await runner.stop();
    process.exit(0);
  });
}

try {
  await runner.start();
  await app.listen({ port: config.port, host: config.host });
  // Read the actual bound address: when PORT=0 was supplied, the OS picked
  // a free port; logging config.port would print 0 (useless for callers).
  const addr = app.server.address();
  const boundHost = typeof addr === "string" ? addr : (addr?.address ?? config.host);
  const boundPort = typeof addr === "string" ? "" : `:${addr?.port ?? config.port}`;
  app.log.info(`hypha-server listening on ${boundHost}${boundPort}`);
} catch (err) {
  app.log.error({ err }, "hypha-server bootstrap failed");
  await runner.stop();
  process.exit(1);
}

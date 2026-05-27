/**
 * End-to-end integration: real node-adapter + real hypha-server + real
 * Hypha-signed JWT round-trip.
 *
 * Verification of plan-section "Annahmen" A3-A6 in one test:
 *   A3: node-adapter spawns successfully as a hypha-server child process.
 *   A4: env-var translation (HYPHA_X -> DB_SYNC_X / COGNITO_X) reaches the
 *       child process.
 *   A5: a Hypha-issued JWT validates against the JWKS that hypha-server's
 *       own /auth/jwks endpoint exposes.
 *   A6: the /sync reverse proxy forwards browser requests to the child
 *       and returns its response unmodified.
 *
 * This test only runs when bin/hypha-build has produced the
 * deps/db-sync/worker/dist/node-adapter.js artifact (and its sibling
 * better-sqlite3 binary). Otherwise the test is skipped with a clear
 * console warning so the lighter unit test suite still passes in
 * dependency-free environments.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AddressInfo } from "node:net";

import bcrypt from "bcryptjs";
import { generateKeyPair, exportJWK } from "jose";

import { buildApp } from "../src/app.ts";
import { DbSyncRunner } from "../src/db-sync-runner.ts";
import type { HyphaRuntime } from "../src/config.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..", "..");
const adapterPath = resolve(repoRoot, "deps/db-sync/worker/dist/node-adapter.js");

const ACCESS_CODE = "integration-test-code";

if (!existsSync(adapterPath)) {
  console.warn(
    `[integration] Skipping db-sync integration tests:\n` +
      `  Adapter not found at ${adapterPath}.\n` +
      `  Run: bin/hypha-build`,
  );
} else {
  test("integration: Hypha-JWT verifies against node-adapter via JWKS round-trip", { timeout: 60_000 }, async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), "hypha-integration-"));

    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "hypha-integ-key";
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const runtime: HyphaRuntime = {
      port: 0,
      host: "127.0.0.1",
      username: "hypha-user",
      userUuid: "00000000-0000-0000-0000-000000000001",
      email: "user@hypha.test",
      accessCodeHash: await bcrypt.hash(ACCESS_CODE, 4),
      jwtIssuer: "https://hypha.integ/issuer",
      jwtAudience: "hypha-integ-audience",
      jwtTtl: "1h",
      sessionTtlSeconds: 3600,
      cookieSecure: false,
      signingKid: "hypha-integ-key",
      staticDirs: [],
      dbSyncInternalPort: 0, // re-assigned below once we pick a port
      dataDir,
      signingPrivateKey: privateKey,
      signingPublicJwk: publicJwk,
    };

    // Use port 0 for hypha-server (OS-picked), and a fixed-ish high port
    // for the adapter so the proxy URL is stable. The adapter does not
    // honour DB_SYNC_PORT=0, so we pick something unlikely to collide.
    const adapterPort = 18787 + Math.floor(Math.random() * 1000);
    runtime.dbSyncInternalPort = adapterPort;

    const app = await buildApp({
      config: runtime,
      syncUpstreamUrl: `http://127.0.0.1:${adapterPort}`,
      logLevel: "silent",
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const hyphaPort = (app.server.address() as AddressInfo).port;

    const runner = new DbSyncRunner({
      adapterPath,
      port: adapterPort,
      dataDir,
      jwtIssuer: runtime.jwtIssuer,
      jwtAudience: runtime.jwtAudience,
      jwksUrl: `http://127.0.0.1:${hyphaPort}/auth/jwks`,
      logger: { info() {}, warn() {}, error() {} },
      startupTimeoutMs: 30_000,
    });

    try {
      await runner.start();

      const hyphaUrl = `http://127.0.0.1:${hyphaPort}`;

      // Step 1: login → get the JWT.
      const loginRes = await fetch(`${hyphaUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: ACCESS_CODE }),
      });
      assert.equal(loginRes.status, 200);
      const loginBody = (await loginRes.json()) as { "id-token": string };
      const jwt = loginBody["id-token"];
      assert.ok(jwt && jwt.split(".").length === 3, "valid JWT received");

      // Step 2: hit /sync/<graph-id>/<anything> via the reverse proxy.
      // node-adapter's dispatch routes /sync/* through graph-access-response,
      // which (a) verifies the JWT against COGNITO_JWKS_URL = our /auth/jwks,
      // (b) extracts `sub`, (c) checks graph access in its SQLite. We expect:
      //   - status NOT 401 — proves JWT verification succeeded.
      //   - the request actually reached the proxy (else hypha-server's
      //     statics catch-all might 404 with hypha-server-y content).
      const syncRes = await fetch(`${hyphaUrl}/sync/some-graph-id/health`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      assert.notEqual(
        syncRes.status,
        401,
        "JWT should verify against node-adapter via JWKS callback",
      );
      // 403 (no graph access) is the expected happy path: auth verified,
      // graph access check failed because we never created a graph.
      assert.equal(
        syncRes.status,
        403,
        `expected 403 (auth ok, no graph access); got ${syncRes.status}`,
      );

      // Step 3: invalid JWT → 401. Sanity check that auth is actually
      // gating: replace the signature with garbage.
      const tampered = jwt.split(".").slice(0, 2).concat(["AAAA"]).join(".");
      const tamperedRes = await fetch(`${hyphaUrl}/sync/some-graph-id/health`, {
        headers: { Authorization: `Bearer ${tampered}` },
      });
      assert.equal(tamperedRes.status, 401, "tampered JWT must be rejected");
    } finally {
      await app.close();
      await runner.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

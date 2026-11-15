/**
 * loadConfig fails fast on values that would otherwise break silently at
 * runtime (every login 401, sessions that never expire, a 500 at the first
 * login).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.ts";

const VALID_HASH = "$2b$10$QsHRSpOlRo8R7Be1GspghOlxi5beCNAN2b2en9F7mezJZ253gNui2";

async function withEnv<T>(env: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await f();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const BASE = {
  HYPHA_ACCESS_CODE_HASH: VALID_HASH,
  HYPHA_JWT_ISSUER: "https://hypha.test",
  HYPHA_JWT_AUDIENCE: "hypha-test",
  HYPHA_DATA_DIR: "/tmp/hypha-config-test",
  HYPHA_JWT_TTL: undefined,
  HYPHA_SESSION_TTL_SECONDS: undefined,
  HYPHA_COOKIE_SECURE: undefined,
  PORT: undefined,
  HYPHA_DB_SYNC_PORT: undefined,
};

test("loadConfig — accepts the defaults with a valid hash", async () => {
  const config = await withEnv(BASE, () => loadConfig());
  assert.equal(config.accessCodeHash, VALID_HASH);
  assert.equal(config.cookieSecure, true, "https issuer");
  assert.equal(config.sessionTtlSeconds, 2592000);
});

test("loadConfig — Secure cookie follows the issuer scheme unless set", async () => {
  assert.equal((await withEnv({ ...BASE, HYPHA_JWT_ISSUER: "https://notes.example.org" }, () => loadConfig())).cookieSecure, true);
  assert.equal((await withEnv({ ...BASE, HYPHA_JWT_ISSUER: "http://localhost:3000" }, () => loadConfig())).cookieSecure, false);
  assert.equal(
    (await withEnv({ ...BASE, HYPHA_JWT_ISSUER: "https://notes.example.org", HYPHA_COOKIE_SECURE: "false" }, () => loadConfig()))
      .cookieSecure,
    false,
  );
});

test("loadConfig — rejects a hash mangled by unquoted $ in .env", async () => {
  // what docker compose leaves of $2b$10$<53 chars> when $2b and $10 expand to ""
  await assert.rejects(
    withEnv({ ...BASE, HYPHA_ACCESS_CODE_HASH: "QsHRSpOlRo8R7Be1GspghOlxi5beCNAN2b2en9F7mezJZ253gNui2" }, () =>
      loadConfig(),
    ),
    /HYPHA_ACCESS_CODE_HASH is not a bcrypt hash/,
  );
});

test("loadConfig — rejects malformed numbers, booleans and durations", async () => {
  await assert.rejects(withEnv({ ...BASE, HYPHA_SESSION_TTL_SECONDS: "30 days" }, () => loadConfig()), /HYPHA_SESSION_TTL_SECONDS/);
  await assert.rejects(withEnv({ ...BASE, HYPHA_COOKIE_SECURE: "True" }, () => loadConfig()), /HYPHA_COOKIE_SECURE/);
  await assert.rejects(withEnv({ ...BASE, PORT: "http" }, () => loadConfig()), /PORT/);
  await assert.rejects(withEnv({ ...BASE, HYPHA_JWT_TTL: "a month" }, () => loadConfig()), /HYPHA_JWT_TTL/);
});

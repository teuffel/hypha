/**
 * Integration tests for the Hypha auth surface.
 *
 * Uses Fastify's inject() — no TCP port is bound. Each describe block builds
 * a fresh app instance with an isolated session store + ephemeral signing key.
 */

import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { jwtVerify, createLocalJWKSet, type JWK } from "jose";

import { buildApp } from "../src/app.ts";
import type { HyphaRuntime } from "../src/config.ts";
import { generateKeyPair, exportJWK } from "jose";

const ACCESS_CODE = "test-access-code";
const ISSUER = "https://hypha.test/issuer";
const AUDIENCE = "hypha-test-audience";

async function makeRuntime(): Promise<HyphaRuntime> {
  const hash = await bcrypt.hash(ACCESS_CODE, 4);
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "hypha-test-key";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";
  return {
    port: 0,
    host: "127.0.0.1",
    username: "hypha-user",
    email: "user@hypha.test",
    accessCodeHash: hash,
    jwtIssuer: ISSUER,
    jwtAudience: AUDIENCE,
    jwtTtl: "1h",
    sessionTtlSeconds: 3600,
    cookieSecure: false,
    signingKid: "hypha-test-key",
    staticDirs: [],
    signingPrivateKey: privateKey,
    signingPublicJwk: publicJwk,
  };
}

async function makeApp() {
  const config = await makeRuntime();
  const app = await buildApp({ config, logLevel: "silent" });
  return { app, config };
}

function parseCookieHeader(header: string | string[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!header) return result;
  const headers = Array.isArray(header) ? header : [header];
  for (const raw of headers) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) {
      result.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  return result;
}

test("POST /auth/login — correct code returns 200 + cookie + JWT", async () => {
  const { app, config } = await makeApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { code: ACCESS_CODE },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { "id-token": string };
    assert.ok(typeof body["id-token"] === "string");
    assert.ok(body["id-token"].split(".").length === 3);

    const cookies = parseCookieHeader(res.headers["set-cookie"]);
    assert.ok(cookies.has("hypha-session"));
    assert.ok((cookies.get("hypha-session") ?? "").length >= 32);

    // JWT verifies against the JWKS endpoint key + correct iss/aud.
    const jwks = createLocalJWKSet({ keys: [config.signingPublicJwk] });
    const { payload, protectedHeader } = await jwtVerify(body["id-token"], jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    assert.equal(protectedHeader.alg, "RS256");
    assert.equal(protectedHeader.kid, "hypha-test-key");
    assert.equal(payload.sub, "hypha-user");
    // V1-(c) defensive double claim
    assert.equal(payload["cognito:username"], "hypha-user");
    assert.equal(payload["preferred_username"], "hypha-user");
    assert.equal(payload.email, "user@hypha.test");
    assert.equal(payload.name, "hypha-user");
  } finally {
    await app.close();
  }
});

test("POST /auth/login — wrong code returns 401", async () => {
  const { app } = await makeApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { code: "wrong-code" },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "invalid_access_code" });
    assert.equal(res.headers["set-cookie"], undefined);
  } finally {
    await app.close();
  }
});

test("POST /auth/login — missing code returns 401", async () => {
  const { app } = await makeApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {},
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("GET /auth/session — valid cookie returns fresh JWT", async () => {
  const { app, config } = await makeApp();
  try {
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { code: ACCESS_CODE },
    });
    const cookies = parseCookieHeader(loginRes.headers["set-cookie"]);
    const sessionCookie = `hypha-session=${cookies.get("hypha-session")}`;

    const res = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: sessionCookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { "id-token": string };
    assert.ok(typeof body["id-token"] === "string");

    // Fresh JWT is verifiable.
    const jwks = createLocalJWKSet({ keys: [config.signingPublicJwk] });
    await jwtVerify(body["id-token"], jwks, { issuer: ISSUER, audience: AUDIENCE });
  } finally {
    await app.close();
  }
});

test("GET /auth/session — no cookie returns 401", async () => {
  const { app } = await makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/auth/session" });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "no_session" });
  } finally {
    await app.close();
  }
});

test("GET /auth/session — unknown cookie returns 401", async () => {
  const { app } = await makeApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: "hypha-session=00000000-0000-0000-0000-000000000000" },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("POST /auth/logout — idempotent + clears cookie", async () => {
  const { app } = await makeApp();
  try {
    // Logout without cookie still succeeds.
    const noCookieRes = await app.inject({ method: "POST", url: "/auth/logout" });
    assert.equal(noCookieRes.statusCode, 204);

    // Login, then logout, then session check is 401.
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { code: ACCESS_CODE },
    });
    const loginCookies = parseCookieHeader(loginRes.headers["set-cookie"]);
    const sessionCookie = `hypha-session=${loginCookies.get("hypha-session")}`;

    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: sessionCookie },
    });
    assert.equal(logoutRes.statusCode, 204);
    // Set-Cookie clears the cookie (browser deletes when seeing empty value
    // with Max-Age=0 or Expires in the past).
    const clearHeader = logoutRes.headers["set-cookie"];
    assert.ok(clearHeader);

    // After logout, the same cookie does not authenticate /auth/session.
    const sessionRes = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: sessionCookie },
    });
    assert.equal(sessionRes.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("GET /auth/jwks — returns JWKS with one RS256 sig key", async () => {
  const { app, config } = await makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/auth/jwks" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { keys: JWK[] };
    assert.equal(body.keys.length, 1);
    const key = body.keys[0]!;
    assert.equal(key.kty, "RSA");
    assert.equal(key.alg, "RS256");
    assert.equal(key.use, "sig");
    assert.equal(key.kid, config.signingKid);
    assert.ok(key.n && key.n.length > 0);
    assert.ok(key.e && key.e.length > 0);
    // Public key only — no private fields.
    assert.equal(("d" in key) ? key.d : undefined, undefined);
  } finally {
    await app.close();
  }
});

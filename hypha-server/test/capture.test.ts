/**
 * Capture inbox — the server half of the Firefox/Thunderbird clippers.
 *
 * The inbox is deliberately NOT a graph writer. Clips are parked in
 * HYPHA_DATA_DIR and the browser drains them on its next boot, because the
 * graph lives in the browser's OPFS and only reaches the server through RTC
 * sync. The server is a mailbox, nothing more.
 *
 * Delivery is at-least-once by design: clips stay in the inbox until the
 * client acks them *after* the blocks are inserted, so a crash mid-drain
 * replays rather than loses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

import { buildApp } from "../src/app.ts";
import { signHyphaJwt } from "../src/auth/jwt.ts";
import type { HyphaRuntime } from "../src/config.ts";

async function makeRuntime(): Promise<HyphaRuntime> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "hypha-test-key";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";
  return {
    port: 0,
    host: "127.0.0.1",
    username: "hypha-user",
    userUuid: "00000000-0000-0000-0000-000000000001",
    email: "user@hypha.test",
    accessCodeHash: await bcrypt.hash("ignored", 4),
    jwtIssuer: "https://hypha.test/issuer",
    jwtAudience: "hypha-test-audience",
    jwtTtl: "1h",
    sessionTtlSeconds: 3600,
    cookieSecure: false,
    signingKid: "hypha-test-key",
    staticDirs: [],
    dbSyncInternalPort: 0,
    dataDir: await mkdtemp(join(tmpdir(), "hypha-capture-")),
    signingPrivateKey: privateKey,
    signingPublicJwk: publicJwk,
  };
}

/** Runtime + a matching bearer token, the normal authenticated setup. */
async function makeAuthed() {
  const config = await makeRuntime();
  const token = await signHyphaJwt(config);
  const app = await buildApp({ config, logLevel: "silent" });
  return { config, app, auth: { authorization: `Bearer ${token}` } };
}

test("POST /capture — rejects an unauthenticated clip", async () => {
  const { app } = await makeAuthed();

  const res = await app.inject({
    method: "POST",
    url: "/capture",
    payload: { title: "T", url: "https://example.com" },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test("POST /capture — rejects a token signed by someone else", async () => {
  const { config, app } = await makeAuthed();
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const forged = await new SignJWT({ "cognito:username": config.username })
    .setProtectedHeader({ alg: "RS256", kid: config.signingKid })
    .setSubject(config.userUuid)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setExpirationTime("1h")
    .sign(foreign.privateKey);

  const res = await app.inject({
    method: "POST",
    url: "/capture",
    headers: { authorization: `Bearer ${forged}` },
    payload: { url: "https://example.com" },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test("POST /capture — rejects an expired token", async () => {
  const { config, app } = await makeAuthed();
  const expired = await new SignJWT({ "cognito:username": config.username })
    .setProtectedHeader({ alg: "RS256", kid: config.signingKid })
    .setSubject(config.userUuid)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(config.signingPrivateKey);

  const res = await app.inject({
    method: "POST",
    url: "/capture",
    headers: { authorization: `Bearer ${expired}` },
    payload: { url: "https://example.com" },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test("POST /capture — stores a clip and returns its id", async () => {
  const { app, auth } = await makeAuthed();

  const res = await app.inject({
    method: "POST",
    url: "/capture",
    headers: auth,
    payload: { title: "An Article", text: "a selected line", url: "https://example.com/a" },
  });

  assert.equal(res.statusCode, 201);
  assert.ok(typeof res.json().id === "string" && res.json().id.length > 0);
  await app.close();
});

test("POST /capture — rejects a clip with nothing in it", async () => {
  const { app, auth } = await makeAuthed();

  const res = await app.inject({
    method: "POST",
    url: "/capture",
    headers: auth,
    payload: { title: "", text: "", url: "" },
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});

test("GET /capture/pending — returns stored clips oldest first", async () => {
  const { app, auth } = await makeAuthed();
  for (const url of ["https://example.com/1", "https://example.com/2", "https://example.com/3"]) {
    await app.inject({ method: "POST", url: "/capture", headers: auth, payload: { url } });
  }

  const res = await app.inject({ method: "GET", url: "/capture/pending", headers: auth });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().clips.map((c: { url: string }) => c.url),
    ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
  );
  await app.close();
});

test("GET /capture/pending — requires auth", async () => {
  const { app } = await makeAuthed();
  const res = await app.inject({ method: "GET", url: "/capture/pending" });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("POST /capture/ack — drops acked clips and keeps the rest", async () => {
  const { app, auth } = await makeAuthed();
  const first = (
    await app.inject({
      method: "POST",
      url: "/capture",
      headers: auth,
      payload: { url: "https://example.com/1" },
    })
  ).json().id;
  await app.inject({
    method: "POST",
    url: "/capture",
    headers: auth,
    payload: { url: "https://example.com/2" },
  });

  const ack = await app.inject({
    method: "POST",
    url: "/capture/ack",
    headers: auth,
    payload: { ids: [first] },
  });

  assert.equal(ack.statusCode, 200);
  assert.equal(ack.json().remaining, 1);

  const pending = (await app.inject({ method: "GET", url: "/capture/pending", headers: auth })).json();
  assert.deepEqual(
    pending.clips.map((c: { url: string }) => c.url),
    ["https://example.com/2"],
  );
  await app.close();
});

test("POST /capture/ack — unknown ids are a no-op, not an error", async () => {
  const { app, auth } = await makeAuthed();
  await app.inject({
    method: "POST",
    url: "/capture",
    headers: auth,
    payload: { url: "https://example.com/1" },
  });

  const ack = await app.inject({
    method: "POST",
    url: "/capture/ack",
    headers: auth,
    payload: { ids: ["never-existed"] },
  });

  assert.equal(ack.statusCode, 200);
  assert.equal(ack.json().remaining, 1);
  await app.close();
});

test("clips survive a server restart", async () => {
  const { config, app, auth } = await makeAuthed();
  await app.inject({
    method: "POST",
    url: "/capture",
    headers: auth,
    payload: { url: "https://example.com/persisted" },
  });
  await app.close();

  // Same dataDir, fresh process-equivalent: the inbox is on disk, so a
  // container restart between clipping and opening Hypha must not lose it.
  const restarted = await buildApp({ config, logLevel: "silent" });
  const res = await restarted.inject({ method: "GET", url: "/capture/pending", headers: auth });

  assert.deepEqual(
    res.json().clips.map((c: { url: string }) => c.url),
    ["https://example.com/persisted"],
  );
  await restarted.close();
});

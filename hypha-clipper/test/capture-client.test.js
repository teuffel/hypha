/**
 * Capture client — access-code login, bearer token reuse, 401 retry.
 *
 * Shared by both clippers, so the auth dance is pinned here rather than
 * discovered twice in the wild. `fetch` is injected; nothing here talks to
 * a real server.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCaptureClient } from "../shared/capture-client.js";

const SETTINGS = { host: "https://hypha.test", accessCode: "s3cret" };

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Records calls and replies from a scripted queue. */
function stubFetch(replies) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next;
  };
  return { impl, calls };
}

test("capture — logs in with the access code, then posts the clip as bearer", async () => {
  const { impl, calls } = stubFetch([
    jsonResponse(200, { "id-token": "jwt-1" }),
    jsonResponse(201, { id: "clip-1" }),
  ]);
  const client = createCaptureClient({ getSettings: async () => SETTINGS, fetchImpl: impl });

  const result = await client.capture({ url: "https://example.com" });

  assert.deepEqual(result, { id: "clip-1" });
  assert.equal(calls[0].url, "https://hypha.test/auth/login");
  assert.deepEqual(calls[0].body, { code: "s3cret" });
  assert.equal(calls[1].url, "https://hypha.test/capture");
  assert.equal(calls[1].init.headers.authorization, "Bearer jwt-1");
  assert.deepEqual(calls[1].body, { url: "https://example.com" });
});

test("capture — reuses the token, so a second clip costs one request", async () => {
  const { impl, calls } = stubFetch([
    jsonResponse(200, { "id-token": "jwt-1" }),
    jsonResponse(201, { id: "clip-1" }),
    jsonResponse(201, { id: "clip-2" }),
  ]);
  const client = createCaptureClient({ getSettings: async () => SETTINGS, fetchImpl: impl });

  await client.capture({ url: "https://example.com/1" });
  await client.capture({ url: "https://example.com/2" });

  assert.equal(calls.filter((c) => c.url.endsWith("/auth/login")).length, 1);
});

test("capture — a 401 triggers one re-login and a retry", async () => {
  // Hypha's signing keys are ephemeral, so a container restart invalidates
  // outstanding tokens. That must be invisible to the user.
  const { impl, calls } = stubFetch([
    jsonResponse(200, { "id-token": "jwt-old" }),
    jsonResponse(401, { error: "unauthorized" }),
    jsonResponse(200, { "id-token": "jwt-new" }),
    jsonResponse(201, { id: "clip-1" }),
  ]);
  const client = createCaptureClient({ getSettings: async () => SETTINGS, fetchImpl: impl });

  const result = await client.capture({ url: "https://example.com" });

  assert.deepEqual(result, { id: "clip-1" });
  assert.equal(calls.filter((c) => c.url.endsWith("/auth/login")).length, 2);
  assert.equal(calls[3].init.headers.authorization, "Bearer jwt-new");
});

test("capture — a wrong access code fails with a message worth showing", async () => {
  const { impl } = stubFetch([jsonResponse(401, { error: "invalid_access_code" })]);
  const client = createCaptureClient({ getSettings: async () => SETTINGS, fetchImpl: impl });

  await assert.rejects(
    () => client.capture({ url: "https://example.com" }),
    /access code/i,
  );
});

test("capture — a persistent 401 gives up after one retry", async () => {
  const { impl, calls } = stubFetch([
    jsonResponse(200, { "id-token": "jwt-1" }),
    jsonResponse(401, { error: "unauthorized" }),
    jsonResponse(200, { "id-token": "jwt-2" }),
    jsonResponse(401, { error: "unauthorized" }),
  ]);
  const client = createCaptureClient({ getSettings: async () => SETTINGS, fetchImpl: impl });

  await assert.rejects(() => client.capture({ url: "https://example.com" }), /401/);
  assert.equal(calls.length, 4, "no endless login/retry loop");
});

test("capture — a server error is surfaced, not swallowed", async () => {
  const { impl } = stubFetch([
    jsonResponse(200, { "id-token": "jwt-1" }),
    jsonResponse(500, { error: "boom" }),
  ]);
  const client = createCaptureClient({ getSettings: async () => SETTINGS, fetchImpl: impl });

  await assert.rejects(() => client.capture({ url: "https://example.com" }), /500/);
});

test("capture — a host with a trailing slash does not produce a double slash", async () => {
  const { impl, calls } = stubFetch([
    jsonResponse(200, { "id-token": "jwt-1" }),
    jsonResponse(201, { id: "clip-1" }),
  ]);
  const client = createCaptureClient({
    getSettings: async () => ({ host: "https://hypha.test/", accessCode: "s3cret" }),
    fetchImpl: impl,
  });

  await client.capture({ url: "https://example.com" });

  assert.equal(calls[0].url, "https://hypha.test/auth/login");
  assert.equal(calls[1].url, "https://hypha.test/capture");
});

test("capture — refuses to run before the host is configured", async () => {
  const { impl } = stubFetch([]);
  const client = createCaptureClient({
    getSettings: async () => ({ host: "", accessCode: "" }),
    fetchImpl: impl,
  });

  await assert.rejects(() => client.capture({ url: "https://example.com" }), /not configured/i);
});

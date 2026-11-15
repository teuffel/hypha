/**
 * Unit tests for the db-sync child-process supervisor.
 *
 * Uses a fake adapter binary (test/fixtures/fake-adapter.js) so the test
 * suite stays self-contained and does not require deps/db-sync to be built.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { DbSyncRunner, type RunnerLogger } from "../src/db-sync-runner.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const adapterPath = resolve(here, "fixtures/fake-adapter.js");

function silentLogger(): RunnerLogger {
  return { info() {}, warn() {}, error() {} };
}

function collectLogger() {
  const entries: { level: string; msg: string }[] = [];
  return {
    entries,
    info: (msg: string) => entries.push({ level: "info", msg }),
    warn: (msg: string) => entries.push({ level: "warn", msg }),
    error: (msg: string) => entries.push({ level: "error", msg }),
  };
}

test("DbSyncRunner — resolves when the adapter prints the ready line", async () => {
  const runner = new DbSyncRunner({
    adapterPath,
    port: 18787,
    dataDir: "/tmp/fake",
    jwtIssuer: "test-issuer",
    jwtAudience: "test-audience",
    jwksUrl: "http://127.0.0.1:1/auth/jwks",
    logger: silentLogger(),
    startupTimeoutMs: 5000,
  });
  await runner.start();
  assert.ok(runner.running);
  await runner.stop();
  assert.equal(runner.running, false);
});

test("DbSyncRunner — reports an exit after ready, but not one caused by stop()", async () => {
  const exits: (number | null)[] = [];
  const logger = collectLogger();
  const runner = new DbSyncRunner({
    adapterPath,
    port: 18787,
    dataDir: "/tmp/fake",
    jwtIssuer: "test-issuer",
    jwtAudience: "test-audience",
    jwksUrl: "http://127.0.0.1:1/auth/jwks",
    logger,
    startupTimeoutMs: 5000,
    onUnexpectedExit: (code) => exits.push(code),
  });
  await runner.start();
  const pid = (runner as unknown as { child: { pid: number } }).child.pid;
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 50 && exits.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(exits.length, 1, "a crash after ready must be reported");
  assert.ok(logger.entries.some((e) => e.level === "error" && /exited unexpectedly/.test(e.msg)));

  const stopped: (number | null)[] = [];
  const runner2 = new DbSyncRunner({
    adapterPath,
    port: 18788,
    dataDir: "/tmp/fake",
    jwtIssuer: "test-issuer",
    jwtAudience: "test-audience",
    jwksUrl: "http://127.0.0.1:1/auth/jwks",
    logger: silentLogger(),
    startupTimeoutMs: 5000,
    onUnexpectedExit: (code) => stopped.push(code),
  });
  await runner2.start();
  await runner2.stop();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(stopped, [], "stop() is not an unexpected exit");
});

// The adapter ignores X-Forwarded-* unless told to trust them; without the
// flag the snapshot URL points at the internal loopback and every graph
// download fails in the browser.
test("DbSyncRunner — passes DB_SYNC_TRUST_FORWARDED_HEADERS=true to the adapter", async () => {
  const logger = collectLogger();
  const runner = new DbSyncRunner({
    adapterPath,
    port: 18789,
    dataDir: "/tmp/fake",
    jwtIssuer: "test-issuer",
    jwtAudience: "test-audience",
    jwksUrl: "http://127.0.0.1:1/auth/jwks",
    logger,
    startupTimeoutMs: 5000,
  });
  process.env.FAKE_ADAPTER_MODE = "env";
  try {
    await runner.start();
    assert.ok(
      logger.entries.some((e) => e.msg.includes("env:DB_SYNC_TRUST_FORWARDED_HEADERS=true")),
      JSON.stringify(logger.entries),
    );
  } finally {
    delete process.env.FAKE_ADAPTER_MODE;
    await runner.stop();
  }
});

test("DbSyncRunner — rejects when the adapter exits before the ready line", async () => {
  const runner = new DbSyncRunner({
    adapterPath,
    port: 18787,
    dataDir: "/tmp/fake",
    jwtIssuer: "test-issuer",
    jwtAudience: "test-audience",
    jwksUrl: "http://127.0.0.1:1/auth/jwks",
    logger: silentLogger(),
    startupTimeoutMs: 5000,
    nodeBinary: process.execPath,
  });
  // Override the spawn environment via env-var the fake adapter reads.
  process.env.FAKE_ADAPTER_MODE = "crash";
  try {
    await assert.rejects(
      () => runner.start(),
      /exited before ready/,
    );
  } finally {
    delete process.env.FAKE_ADAPTER_MODE;
  }
});

test("DbSyncRunner — rejects on startup timeout", async () => {
  const runner = new DbSyncRunner({
    adapterPath,
    port: 18787,
    dataDir: "/tmp/fake",
    jwtIssuer: "test-issuer",
    jwtAudience: "test-audience",
    jwksUrl: "http://127.0.0.1:1/auth/jwks",
    logger: silentLogger(),
    startupTimeoutMs: 200,
  });
  process.env.FAKE_ADAPTER_MODE = "silent";
  try {
    await assert.rejects(
      () => runner.start(),
      /did not become ready within 200ms/,
    );
  } finally {
    delete process.env.FAKE_ADAPTER_MODE;
    await runner.stop();
  }
});

test("DbSyncRunner — forwards adapter stdout/stderr through the logger", async () => {
  const logger = collectLogger();
  const runner = new DbSyncRunner({
    adapterPath,
    port: 18787,
    dataDir: "/tmp/fake",
    jwtIssuer: "test-issuer",
    jwtAudience: "test-audience",
    jwksUrl: "http://127.0.0.1:1/auth/jwks",
    logger,
    startupTimeoutMs: 5000,
  });
  await runner.start();
  await runner.stop();
  const readyLines = logger.entries.filter((e) =>
    e.msg.includes("Logseq sync listening on port"),
  );
  assert.ok(readyLines.length >= 1, "expected at least one ready line via logger");
  assert.equal(readyLines[0]!.level, "info");
  assert.ok(readyLines[0]!.msg.startsWith("[db-sync] "));
});

test("DbSyncRunner — start() throws if called twice on the same instance", async () => {
  const runner = new DbSyncRunner({
    adapterPath,
    port: 18787,
    dataDir: "/tmp/fake",
    jwtIssuer: "test-issuer",
    jwtAudience: "test-audience",
    jwksUrl: "http://127.0.0.1:1/auth/jwks",
    logger: silentLogger(),
    startupTimeoutMs: 5000,
  });
  try {
    await runner.start();
    await assert.rejects(() => runner.start(), /called twice/);
  } finally {
    await runner.stop();
  }
});

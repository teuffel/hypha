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

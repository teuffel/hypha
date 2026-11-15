import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/auth/session.js";

function withDir(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hypha-sessions-"));
  try {
    fn(join(dir, "sessions.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a session survives a restart (new store on the same file)", () => {
  withDir((path) => {
    const id = new SessionStore(60, path).create("hypha-user");
    const record = new SessionStore(60, path).lookup(id);
    assert.equal(record?.username, "hypha-user");
  });
});

test("a deleted session stays deleted after a restart", () => {
  withDir((path) => {
    const store = new SessionStore(60, path);
    const id = store.create("hypha-user");
    store.delete(id);
    assert.equal(new SessionStore(60, path).lookup(id), undefined);
  });
});

test("an expired session is not restored", () => {
  withDir((path) => {
    const id = new SessionStore(0, path).create("hypha-user");
    assert.equal(new SessionStore(60, path).lookup(id), undefined);
  });
});

test("the file holds no usable cookie value", () => {
  withDir((path) => {
    const id = new SessionStore(60, path).create("hypha-user");
    assert.ok(!readFileSync(path, "utf8").includes(id));
  });
});

test("without a file the store stays in memory", () => {
  const store = new SessionStore(60);
  const id = store.create("hypha-user");
  assert.equal(store.lookup(id)?.username, "hypha-user");
});

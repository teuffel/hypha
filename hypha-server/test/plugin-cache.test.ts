/**
 * Unit tests for the PluginCache LRU+TTL store and the `isSafeSubpath`
 * path-traversal guard.
 *
 * `serveCached` is exercised by plugin-market-proxy.test.ts where a real
 * Fastify reply + a fake upstream are available.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PluginCache, isSafeSubpath, type CacheEntry } from "../src/plugin-cache.ts";

function makeEntry(body: string, ttlMs: number, contentType = "application/json"): CacheEntry {
  return {
    body: Buffer.from(body, "utf8"),
    contentType,
    expiresAt: Date.now() + ttlMs,
  };
}

test("PluginCache — get() on missing key returns undefined + counts miss", () => {
  const c = new PluginCache(4);
  assert.equal(c.get("nope"), undefined);
  const stats = c.getStats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 1);
  assert.equal(stats.size, 0);
});

test("PluginCache — set() + get() returns entry and counts hit", () => {
  const c = new PluginCache(4);
  c.set("a", makeEntry("hello", 60_000));
  const got = c.get("a");
  assert.ok(got);
  assert.equal(got!.body.toString("utf8"), "hello");
  assert.equal(got!.contentType, "application/json");
  const stats = c.getStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 0);
  assert.equal(stats.size, 1);
});

test("PluginCache — expired entry is dropped on get(), counts miss", () => {
  const c = new PluginCache(4);
  c.set("a", { body: Buffer.from("stale"), contentType: "text/plain", expiresAt: Date.now() - 1 });
  assert.equal(c.get("a"), undefined);
  const stats = c.getStats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 1);
  assert.equal(stats.size, 0, "expired entry must be removed from the store");
});

test("PluginCache — capacity bound evicts oldest insertion", () => {
  const c = new PluginCache(2);
  c.set("a", makeEntry("1", 60_000));
  c.set("b", makeEntry("2", 60_000));
  c.set("c", makeEntry("3", 60_000)); // evicts "a"

  assert.equal(c.get("a"), undefined, "oldest entry should be evicted");
  assert.ok(c.get("b"));
  assert.ok(c.get("c"));

  const stats = c.getStats();
  assert.equal(stats.evictions, 1);
  assert.equal(stats.size, 2);
});

test("PluginCache — get() promotes hit to most-recently-used (LRU touch)", () => {
  const c = new PluginCache(2);
  c.set("a", makeEntry("1", 60_000));
  c.set("b", makeEntry("2", 60_000));
  // Touch "a" so it becomes most-recent. "b" is now the oldest.
  assert.ok(c.get("a"));
  c.set("c", makeEntry("3", 60_000)); // should evict "b", not "a"

  assert.ok(c.get("a"), "touched entry must survive the next eviction");
  assert.equal(c.get("b"), undefined, "untouched entry should have been evicted");
  assert.ok(c.get("c"));
});

test("PluginCache — re-setting an existing key refreshes order and overwrites body", () => {
  const c = new PluginCache(2);
  c.set("a", makeEntry("old", 60_000));
  c.set("b", makeEntry("2", 60_000));
  c.set("a", makeEntry("new", 60_000)); // "a" is now most-recent; "b" oldest
  c.set("c", makeEntry("3", 60_000));   // evicts "b"

  const a = c.get("a");
  assert.ok(a);
  assert.equal(a!.body.toString("utf8"), "new");
  assert.equal(c.get("b"), undefined);
  assert.ok(c.get("c"));
});

test("PluginCache — clear() empties the store but keeps stats counters", () => {
  const c = new PluginCache(4);
  c.set("a", makeEntry("1", 60_000));
  c.get("a"); // 1 hit
  c.get("missing"); // 1 miss
  c.clear();
  assert.equal(c.get("a"), undefined);
  const stats = c.getStats();
  assert.equal(stats.size, 0);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 2); // pre-clear miss + post-clear miss
});

test("PluginCache — constructor rejects non-positive capacity", () => {
  assert.throws(() => new PluginCache(0), /maxEntries must be > 0/);
  assert.throws(() => new PluginCache(-1), /maxEntries must be > 0/);
});

test("isSafeSubpath — accepts plain relative subpaths", () => {
  assert.equal(isSafeSubpath("plugins.json"), true);
  assert.equal(isSafeSubpath("packages/foo/icon.png"), true);
  assert.equal(isSafeSubpath("logseq/logseq-plugin-tags"), true);
  assert.equal(isSafeSubpath("a/b/c/d.js"), true);
});

test("isSafeSubpath — rejects empty, absolute, and traversal paths", () => {
  assert.equal(isSafeSubpath(""), false);
  assert.equal(isSafeSubpath("/etc/passwd"), false);
  assert.equal(isSafeSubpath("\\windows"), false);
  assert.equal(isSafeSubpath(".."), false);
  assert.equal(isSafeSubpath("../foo"), false);
  assert.equal(isSafeSubpath("foo/.."), false);
  assert.equal(isSafeSubpath("foo/../bar"), false);
  assert.equal(isSafeSubpath("foo\\..\\bar"), false);
});

test("isSafeSubpath — segment containing '..' as a substring is fine", () => {
  // Only the literal segment ".." is rejected; "..foo" or "foo.." are legal
  // names that GitHub raw URLs accept verbatim.
  assert.equal(isSafeSubpath("..foo"), true);
  assert.equal(isSafeSubpath("foo.."), true);
  assert.equal(isSafeSubpath("a/..b/c"), true);
});

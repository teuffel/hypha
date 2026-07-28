/**
 * Clip construction — the part of the clippers worth unit-testing.
 *
 * Everything else in the extensions is browser glue (menus, toolbar
 * buttons, storage) that only proves itself in a real Firefox/Thunderbird.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildPageClip, buildMessageClip } from "../shared/clip.js";

test("buildPageClip — carries title, url and selection", () => {
  assert.deepEqual(
    buildPageClip({
      title: "An Article",
      url: "https://example.com/a",
      selection: "the interesting sentence",
    }),
    { title: "An Article", url: "https://example.com/a", text: "the interesting sentence" },
  );
});

test("buildPageClip — omits an empty selection instead of sending an empty field", () => {
  assert.deepEqual(buildPageClip({ title: "An Article", url: "https://example.com/a", selection: "" }), {
    title: "An Article",
    url: "https://example.com/a",
  });
});

test("buildPageClip — trims whitespace the browser hands over", () => {
  assert.deepEqual(
    buildPageClip({ title: "  Padded  ", url: "https://example.com/a", selection: "\n  picked  \n" }),
    { title: "Padded", url: "https://example.com/a", text: "picked" },
  );
});

test("buildPageClip — a selection-only clip is valid (no title, no url)", () => {
  assert.deepEqual(buildPageClip({ selection: "just this" }), { text: "just this" });
});

test("buildMessageClip — subject becomes the title, sender and date the text", () => {
  const clip = buildMessageClip({
    subject: "Rechnung Q3",
    author: "Alice <alice@example.com>",
    date: new Date("2026-07-28T09:15:00Z"),
    headerMessageId: "abc123@example.com",
  });

  assert.equal(clip.title, "Rechnung Q3");
  assert.equal(clip.text, "From: Alice <alice@example.com> (2026-07-28)");
  // RFC 2392 message id — a stable pointer back to the mail, searchable in
  // Thunderbird even where the OS has no mid: protocol handler.
  assert.equal(clip.url, "mid:abc123@example.com");
});

test("buildMessageClip — a subject-less mail still yields a usable clip", () => {
  const clip = buildMessageClip({
    subject: "",
    author: "Bob <bob@example.com>",
    date: new Date("2026-07-28T09:15:00Z"),
    headerMessageId: "def456@example.com",
  });

  assert.equal(clip.title, undefined);
  assert.equal(clip.text, "From: Bob <bob@example.com> (2026-07-28)");
  assert.equal(clip.url, "mid:def456@example.com");
});

test("buildMessageClip — a mail without a message id still captures", () => {
  const clip = buildMessageClip({
    subject: "No id",
    author: "Bob <bob@example.com>",
    date: new Date("2026-07-28T09:15:00Z"),
    headerMessageId: "",
  });

  assert.equal(clip.url, undefined);
  assert.equal(clip.title, "No id");
});

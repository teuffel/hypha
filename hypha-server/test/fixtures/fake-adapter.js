#!/usr/bin/env node
// Test fixture: stands in for deps/db-sync/worker/dist/node-adapter.js.
//
// Behaviour is controlled by FAKE_ADAPTER_MODE:
//   "ready"       — print the ready line immediately and sleep (default)
//   "slow"        — wait FAKE_ADAPTER_DELAY_MS then print ready line
//   "crash"       — exit(1) immediately, no ready line
//   "silent"      — never print the ready line, keep running

const mode = process.env.FAKE_ADAPTER_MODE ?? "ready";
const port = process.env.DB_SYNC_PORT ?? "8787";

function emitReady() {
  console.log(`Logseq sync listening on port ${port}`);
}

switch (mode) {
  case "crash":
    console.error("fake-adapter: simulating early crash");
    process.exit(1);
    break;
  case "silent":
    setInterval(() => {}, 1000);
    break;
  case "slow":
    setTimeout(() => emitReady(), Number(process.env.FAKE_ADAPTER_DELAY_MS ?? "500"));
    setInterval(() => {}, 1000);
    break;
  case "ready":
  default:
    emitReady();
    setInterval(() => {}, 1000);
    break;
}

process.on("SIGTERM", () => process.exit(0));

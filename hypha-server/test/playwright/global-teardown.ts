/**
 * Playwright globalTeardown: stop the hypha-server that globalSetup spawned.
 *
 * State (pid + baseURL + mock-upstream-port) is read from the .state JSON
 * file that globalSetup wrote.
 *
 * Idempotent: missing state file or already-dead pid is treated as success.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const stateDir = resolve(here, ".state");
const statePath = resolve(stateDir, "server.json");

interface ServerState {
  pid: number;
  baseUrl: string;
  mockUpstreamPort: number;
}

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(statePath)) return;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as ServerState;
  try {
    process.kill(state.pid, "SIGTERM");
    // Give the parent a moment to drain child stdout + run its own shutdown.
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 500));
  } catch {
    // ESRCH = already dead; OK.
  }
  rmSync(stateDir, { recursive: true, force: true });
}

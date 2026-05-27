/**
 * Playwright globalSetup for the headless-auth smoke test.
 *
 * Bootstraps a fully-running Hypha stack (hypha-server + mocked /sync
 * upstream) and writes the resulting baseURL + access code into env vars
 * that the spec file reads.
 *
 * Pre-condition: `bin/hypha-build --release` was run, so static/ contains
 * a browser-loadable Hypha bundle. Failing fast on a missing bundle is
 * the right behaviour — silently running the test against a stale bundle
 * defeats its purpose (catching semantic upstream drift in the rendered
 * frontend).
 *
 * The bootstrap also stashes a process-handle file in test/playwright/.state
 * so globalTeardown can shut down cleanly. We avoid passing handles via
 * globals because globalSetup and globalTeardown run in separate Node
 * processes when Playwright's workers feature is engaged.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import http, { type AddressInfo } from "node:http";

import bcrypt from "bcryptjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const stateDir = resolve(here, ".state");
const statePath = resolve(stateDir, "server.json");
const repoRoot = resolve(here, "..", "..", "..");
const staticDir = resolve(repoRoot, "static");
const mainJs = resolve(staticDir, "js", "main.js");
const adapterMockPath = resolve(here, "..", "fixtures", "fake-adapter.js");

const ACCESS_CODE = "hypha-test";

interface ServerState {
  pid: number;
  baseUrl: string;
  mockUpstreamPort: number;
}

function checkBundlePresent(): void {
  if (!existsSync(mainJs)) {
    throw new Error(
      `headless-auth bootstrap: static/js/main.js not found at ${mainJs}.\n` +
        `Run \`bin/hypha-build --release\` first to produce the Hypha frontend bundle.`,
    );
  }
  const bundle = readFileSync(mainJs, "utf8");
  if (!bundle.includes("cp__hypha-login")) {
    throw new Error(
      `headless-auth bootstrap: static/js/main.js exists but is not a Hypha build\n` +
        `(missing 'cp__hypha-login' marker; HYPHA_MODE was likely false at build time).\n` +
        `Run \`bin/hypha-build --release\` to rebuild.`,
    );
  }
}

async function startMockSyncUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  // Returns 403 for every /sync* request. The headless test never exercises
  // the actual graph access path; it only needs the proxy to NOT crash on a
  // missing upstream when the test code happens to hit /sync.
  const server = http.createServer((req, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, mock: true, path: req.url }));
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

function startHyphaServer(opts: {
  mockUpstreamPort: number;
  accessCodeHash: string;
}): { child: ChildProcess; ready: Promise<string> } {
  const env = {
    ...process.env,
    PORT: "0",
    HOST: "127.0.0.1",
    HYPHA_ACCESS_CODE_HASH: opts.accessCodeHash,
    HYPHA_JWT_ISSUER: "http://localhost",
    HYPHA_JWT_AUDIENCE: "hypha-test",
    HYPHA_COOKIE_SECURE: "false",
    HYPHA_DB_SYNC_PORT: String(opts.mockUpstreamPort),
    HYPHA_DB_SYNC_ADAPTER_PATH: adapterMockPath,
    HYPHA_DATA_DIR: "/tmp/hypha-headless-data",
    HYPHA_STATIC_DIR: staticDir,
  };
  // Use the compiled dist/ so the test exercises the same artifact as the
  // Docker image. Pre-condition: tsc has been run (Dockerfile.hypha + CI
  // both run `pnpm --dir hypha-server build` before the headless test).
  const distMain = resolve(here, "..", "..", "dist", "main.js");
  const child = spawn(process.execPath, [distMain], { env, stdio: ["ignore", "pipe", "pipe"] });

  const ready = new Promise<string>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("hypha-server didn't print listening URL within 30s")), 30_000);
    let buf = "";
    const onChunk = (data: Buffer) => {
      buf += data.toString("utf8");
      // Pino emits JSON; pull the "msg" field of the listening line and
      // extract host:port (host may contain `:` for IPv6, but our HOST=127.0.0.1
      // here so we know the shape).
      const match = buf.match(/"hypha-server listening on ([^"]+)"/);
      if (match) {
        clearTimeout(timeout);
        child.stdout?.off("data", onChunk);
        resolveReady(`http://${match[1]}`);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", (data: Buffer) => process.stderr.write(`[hypha-headless stderr] ${data.toString("utf8")}`));
  });

  return { child, ready };
}

export default async function globalSetup(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("[headless-auth setup] starting");
  checkBundlePresent();
  // eslint-disable-next-line no-console
  console.log("[headless-auth setup] bundle ok");

  const mock = await startMockSyncUpstream();
  // eslint-disable-next-line no-console
  console.log(`[headless-auth setup] mock /sync upstream on :${mock.port}`);
  const accessCodeHash = await bcrypt.hash(ACCESS_CODE, 4);

  const { child, ready } = startHyphaServer({
    mockUpstreamPort: mock.port,
    accessCodeHash,
  });

  let baseUrl: string;
  try {
    baseUrl = await ready;
    // eslint-disable-next-line no-console
    console.log(`[headless-auth setup] hypha-server ready at ${baseUrl}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[headless-auth setup] hypha-server failed to start", err);
    child.kill("SIGTERM");
    await mock.close();
    throw err;
  }

  mkdirSync(stateDir, { recursive: true });
  const state: ServerState = {
    pid: child.pid!,
    baseUrl,
    mockUpstreamPort: mock.port,
  };
  writeFileSync(statePath, JSON.stringify(state));

  // Pass to specs via env vars.
  process.env.HYPHA_BASE_URL = baseUrl;
  process.env.HYPHA_TEST_ACCESS_CODE = ACCESS_CODE;
  // eslint-disable-next-line no-console
  console.log(`[headless-auth setup] HYPHA_BASE_URL=${process.env.HYPHA_BASE_URL}`);
}

export { ACCESS_CODE, statePath, type ServerState };

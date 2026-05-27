/**
 * db-sync child-process supervisor.
 *
 * Spawns the bundled `deps/db-sync/worker/dist/node-adapter.js` as a child
 * process of hypha-server. The adapter persists SQLite + assets under
 * `dataDir`, and verifies JWTs by fetching JWKS from `jwksUrl` (which we
 * point back at hypha-server's own /auth/jwks endpoint — see jwt.ts for
 * the V1-(c) defensive double-claim shape).
 *
 * Env-var translation (HYPHA_* → DB_SYNC_* / COGNITO_*):
 *   HYPHA_DB_SYNC_PORT  → DB_SYNC_PORT
 *   HYPHA_DATA_DIR      → DB_SYNC_DATA_DIR
 *   HYPHA_JWT_ISSUER    → COGNITO_ISSUER
 *   HYPHA_JWT_AUDIENCE  → COGNITO_CLIENT_ID
 *   (derived JWKS URL)  → COGNITO_JWKS_URL
 *
 * The node-adapter signals readiness with a stdout line:
 *   "Logseq sync listening on port <N>"
 * (See deps/db-sync/src/logseq/db_sync/node/entry.cljs.) We pattern-match
 * that line + apply a startup timeout.
 *
 * M2 lifecycle is intentionally minimal:
 *   - One spawn at hypha-server boot.
 *   - SIGTERM on hypha-server shutdown.
 *   - No auto-restart on crash (logged + surfaced; M3+ may add backoff).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

export interface RunnerLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface DbSyncRunnerOptions {
  /** Absolute path to the compiled node-adapter.js bundle. */
  adapterPath: string;
  /** Internal port for the node-adapter to listen on. */
  port: number;
  /** Absolute path to the data directory (SQLite + assets). */
  dataDir: string;
  /** JWT iss claim that node-adapter must enforce. */
  jwtIssuer: string;
  /** JWT aud claim that node-adapter must enforce. */
  jwtAudience: string;
  /** URL where node-adapter fetches the JWKS (typically hypha-server's own). */
  jwksUrl: string;
  /** Logger used for tagged forward-logging of child stdout/stderr. */
  logger: RunnerLogger;
  /** How long to wait for the readiness line before failing start(). */
  startupTimeoutMs?: number;
  /** Override for Node.js binary used to spawn the child. */
  nodeBinary?: string;
}

const READY_LINE = /Logseq sync listening on port (\d+)/;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

export class DbSyncRunner {
  private child: ChildProcess | null = null;
  private readonly opts: DbSyncRunnerOptions;

  constructor(opts: DbSyncRunnerOptions) {
    this.opts = opts;
  }

  /**
   * Start the child + resolve when it logs the readiness line.
   * Throws on startup failure, early exit, or timeout.
   */
  async start(): Promise<void> {
    if (this.child) {
      throw new Error("db-sync-runner: start() called twice");
    }

    const nodeBin = this.opts.nodeBinary ?? process.execPath;
    const env = {
      ...process.env,
      DB_SYNC_PORT: String(this.opts.port),
      DB_SYNC_DATA_DIR: this.opts.dataDir,
      COGNITO_ISSUER: this.opts.jwtIssuer,
      COGNITO_CLIENT_ID: this.opts.jwtAudience,
      COGNITO_JWKS_URL: this.opts.jwksUrl,
    };

    this.child = spawn(nodeBin, [this.opts.adapterPath], {
      cwd: dirname(this.opts.adapterPath),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const child = this.child;
    const logger = this.opts.logger;

    // Forward stdout / stderr line-by-line with a tag.
    const stdout = createInterface({ input: child.stdout! });
    const stderr = createInterface({ input: child.stderr! });
    stdout.on("line", (line) => logger.info(`[db-sync] ${line}`));
    stderr.on("line", (line) => logger.warn(`[db-sync stderr] ${line}`));

    const timeoutMs = this.opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdout.off("line", onStdoutLine);
        child.off("exit", onEarlyExit);
        child.off("error", onSpawnError);
        fn();
      };

      const onStdoutLine = (line: string) => {
        if (READY_LINE.test(line)) {
          settle(() => resolve());
        }
      };
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(() =>
          reject(
            new Error(
              `db-sync-runner: node-adapter exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`,
            ),
          ),
        );
      };
      const onSpawnError = (err: Error) => {
        settle(() => reject(err));
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `db-sync-runner: node-adapter did not become ready within ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);

      stdout.on("line", onStdoutLine);
      child.once("exit", onEarlyExit);
      child.once("error", onSpawnError);
    });
  }

  /**
   * Send SIGTERM to the child. Resolves once it exits, or after a 5s
   * fallback that escalates to SIGKILL.
   */
  async stop(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) {
      this.child = null;
      return;
    }
    const child = this.child;
    return new Promise<void>((resolve) => {
      const escalate = setTimeout(() => {
        if (child.exitCode === null) {
          this.opts.logger.warn("db-sync-runner: SIGTERM ignored, escalating to SIGKILL");
          child.kill("SIGKILL");
        }
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(escalate);
        this.child = null;
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  /** Whether the child is currently alive. */
  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }
}

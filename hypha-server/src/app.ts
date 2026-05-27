/**
 * Fastify app factory.
 *
 * Split out from main.ts so the test suite can build an instance and use
 * Fastify's `inject()` API without binding a TCP port.
 *
 * The factory wires:
 *   - cookie parsing (hypha-session HttpOnly cookie)
 *   - /auth/login, /auth/session, /auth/logout, /auth/jwks
 *   - /health
 *   - / (statics root)
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";

import type { HyphaRuntime } from "./config.js";
import { SessionStore } from "./auth/session.js";
import { loginRoute } from "./routes/login.js";
import { sessionRoute } from "./routes/session.js";
import { logoutRoute } from "./routes/logout.js";
import { jwksRoute } from "./routes/jwks.js";
import { staticsRoute } from "./statics.js";

export interface BuildAppOptions {
  config: HyphaRuntime;
  /**
   * Optional static directory root. When unset, statics serving is skipped —
   * useful for tests that only exercise the auth API surface.
   */
  staticDir?: string;
  logLevel?: string;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logLevel === "silent" ? false : { level: opts.logLevel ?? "info" },
  });

  await app.register(fastifyCookie);

  const sessions = new SessionStore(opts.config.sessionTtlSeconds);

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(loginRoute, { config: opts.config, sessions });
  await app.register(sessionRoute, { config: opts.config, sessions });
  await app.register(logoutRoute, { sessions });
  await app.register(jwksRoute, { config: opts.config });

  if (opts.staticDir) {
    await app.register(staticsRoute, { staticDir: opts.staticDir });
  }

  return app;
}

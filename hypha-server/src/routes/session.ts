/**
 * GET /auth/session
 *
 * Cookie-authenticated: reads hypha-session cookie, looks up the in-memory
 * session, and mints a fresh JWT if valid.
 *
 * Success (200): { "id-token": "<JWT>" }
 * Failure (401): { error: "no_session" }
 *
 * This is the page-reload path: hypha-init/start! calls /auth/session on every
 * app boot. If the cookie is still valid, the user stays logged in without
 * seeing the login modal again.
 */

import type { FastifyPluginAsync } from "fastify";
import type { HyphaRuntime } from "../config.js";
import { signHyphaJwt } from "../auth/jwt.js";
import { SessionStore, SESSION_COOKIE_NAME } from "../auth/session.js";

interface SessionDeps {
  config: HyphaRuntime;
  sessions: SessionStore;
}

export const sessionRoute: FastifyPluginAsync<SessionDeps> = async (app, deps) => {
  app.get("/auth/session", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (!sessionId) {
      return reply.code(401).send({ error: "no_session" });
    }
    const record = deps.sessions.lookup(sessionId);
    if (!record) {
      return reply.code(401).send({ error: "no_session" });
    }
    const idToken = await signHyphaJwt(deps.config);
    return reply.code(200).send({ "id-token": idToken });
  });
};

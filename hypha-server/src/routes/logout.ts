/**
 * POST /auth/logout
 *
 * Idempotent: returns 204 whether the cookie was present or not. Always
 * clears the cookie + drops any matching session record.
 */

import type { FastifyPluginAsync } from "fastify";
import { SessionStore, SESSION_COOKIE_NAME } from "../auth/session.js";

interface LogoutDeps {
  sessions: SessionStore;
}

export const logoutRoute: FastifyPluginAsync<LogoutDeps> = async (app, deps) => {
  app.post("/auth/logout", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (sessionId) {
      deps.sessions.delete(sessionId);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });
};

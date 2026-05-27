/**
 * POST /auth/login
 *
 * Body: { code: string }
 *
 * Success (200):
 *   - Set-Cookie hypha-session=<opaque-uuid>; HttpOnly; SameSite=Strict; ...
 *   - Body: { "id-token": "<JWT>" }
 *
 * Failure (401):
 *   - Body: { error: "invalid_access_code" }
 *
 * The access code is verified with bcryptjs against HYPHA_ACCESS_CODE_HASH.
 * The resulting cookie is opaque (random UUID); the JWT is signed RS256 and
 * carries the V1-(c) defensive double-claim (see auth/jwt.ts).
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { HyphaRuntime } from "../config.js";
import { verifyAccessCode } from "../auth/access-code.js";
import { signHyphaJwt } from "../auth/jwt.js";
import { SessionStore, SESSION_COOKIE_NAME } from "../auth/session.js";

interface LoginDeps {
  config: HyphaRuntime;
  sessions: SessionStore;
}

interface LoginBody {
  code?: unknown;
}

function setSessionCookie(reply: FastifyReply, deps: LoginDeps, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: "strict",
    path: "/",
    maxAge: deps.config.sessionTtlSeconds,
  });
}

export const loginRoute: FastifyPluginAsync<LoginDeps> = async (app, deps) => {
  app.post("/auth/login", async (request, reply) => {
    const body = request.body as LoginBody | undefined;
    const code = typeof body?.code === "string" ? body.code : "";
    if (code.length === 0) {
      return reply.code(401).send({ error: "invalid_access_code" });
    }
    const ok = await verifyAccessCode(code, deps.config.accessCodeHash);
    if (!ok) {
      return reply.code(401).send({ error: "invalid_access_code" });
    }
    const sessionId = deps.sessions.create(deps.config.username);
    const idToken = await signHyphaJwt(deps.config);
    setSessionCookie(reply, deps, sessionId);
    return reply.code(200).send({ "id-token": idToken });
  });
};

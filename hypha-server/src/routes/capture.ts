/**
 * Capture inbox API — used by the Firefox and Thunderbird clippers.
 *
 *   POST /capture         { title?, text?, url? }  → 201 { id }
 *   GET  /capture/pending                         → 200 { clips: [...] }
 *   POST /capture/ack     { ids: [...] }          → 200 { remaining }
 *
 * Auth is a Hypha JWT in `Authorization: Bearer`. Extensions obtain one by
 * POSTing the access code to /auth/login, exactly like the web app, and
 * re-login on 401 (signing keys are ephemeral, so a container restart
 * invalidates outstanding tokens).
 *
 * The session cookie is deliberately not accepted here: it is SameSite=Strict,
 * so a request originating from an extension would not carry it anyway.
 *
 * Draining is a two-step fetch-then-ack rather than a destructive read, so
 * a browser that dies between fetching and inserting replays the clips
 * instead of dropping them. See capture-inbox.ts.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { HyphaRuntime } from "../config.js";
import { verifyHyphaJwt } from "../auth/jwt.js";
import { CaptureInbox, type ClipInput } from "../capture-inbox.js";

interface CaptureDeps {
  config: HyphaRuntime;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

export const captureRoute: FastifyPluginAsync<CaptureDeps> = async (app, deps) => {
  const inbox = new CaptureInbox(deps.config.dataDir);

  const requireJwt = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(request);
    if (!token || !(await verifyHyphaJwt(token, deps.config))) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.post("/capture", { preHandler: requireJwt }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const field = (key: string): string | undefined => {
      const value = body[key];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };

    const input: ClipInput = {
      title: field("title"),
      text: field("text"),
      url: field("url"),
    };
    if (!input.title && !input.text && !input.url) {
      return reply.code(400).send({ error: "empty_clip" });
    }

    const clip = await inbox.add(input);
    return reply.code(201).send({ id: clip.id });
  });

  app.get("/capture/pending", { preHandler: requireJwt }, async () => ({
    clips: await inbox.list(),
  }));

  app.post("/capture/ack", { preHandler: requireJwt }, async (request) => {
    const body = (request.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    return { remaining: await inbox.ack(ids) };
  });
};

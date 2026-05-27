/**
 * hypha-server entry point.
 *
 * M0 (current): minimal Fastify with /health only. Just enough to verify the
 * build-and-run pipeline produces a working binary that listens on a port.
 *
 * Future milestones will wire in:
 *   - /auth/login, /auth/session, /auth/logout, /auth/jwks (M1)
 *   - Reverse-proxy for /sync/* to the spawned node-adapter.js (M2)
 *   - Static serving for the Hypha-built Logseq frontend (M2)
 *
 * See docs/hypha/phase-1-plan.md section 4 for the full architecture.
 */

import Fastify from "fastify";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
});

app.get("/health", async () => ({ status: "ok" }));

// Default port 3000 for dev convenience. Production Docker image will set
// PORT=80 in docker-compose.hypha.yml (Phase 1 / M3). Note: phase-1-plan.md
// mentions ":80" in the architecture diagram — that refers to the container's
// external-facing port, not the dev-loopback port.
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
  app.log.info(`hypha-server listening on ${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

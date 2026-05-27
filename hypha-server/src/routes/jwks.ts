/**
 * GET /auth/jwks
 *
 * Serves the public half of the ephemeral signing key in JWKS format so
 * downstream JWT verifiers (deps/db-sync) can validate the Hypha-issued JWT
 * via the standard JWKS-URL mechanism.
 *
 * The same kid is set in both the JWT header and the JWK entry.
 */

import type { FastifyPluginAsync } from "fastify";
import type { HyphaRuntime } from "../config.js";

interface JwksDeps {
  config: HyphaRuntime;
}

export const jwksRoute: FastifyPluginAsync<JwksDeps> = async (app, deps) => {
  app.get("/auth/jwks", async () => {
    return { keys: [deps.config.signingPublicJwk] };
  });
};

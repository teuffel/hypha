/**
 * Hypha-server runtime configuration.
 *
 * Pure env-var parsing + ephemeral key material generation.
 * Loaded once at process start by buildApp().
 *
 * Fail-fast: required env vars throw on load. We do NOT mask missing config
 * with defaults (per AGENTS.md "Error handling and compatibility").
 */

import { generateKeyPair, exportJWK, type JWK, type KeyLike } from "jose";

export interface HyphaConfig {
  port: number;
  host: string;
  /** Stable username burned into JWTs for the single-user Phase-1 setup. */
  username: string;
  email: string;
  /** bcryptjs hash of the access code. Verified by routes/login.ts. */
  accessCodeHash: string;
  /** JWT iss claim. Hypha-issuer. */
  jwtIssuer: string;
  /** JWT aud claim. */
  jwtAudience: string;
  /** Lifetime of the issued JWT. jose duration string (e.g. "30d"). */
  jwtTtl: string;
  /** Lifetime of the session cookie in seconds. */
  sessionTtlSeconds: number;
  /** Cookie Secure flag. Force off for plain http://localhost dev. */
  cookieSecure: boolean;
  /** Identifier embedded in the JWT header `kid` + the JWK in /auth/jwks. */
  signingKid: string;
  /** Path under which static asset directories are served. */
  staticDirs: { url: string; dir: string }[];
  /** Internal port the spawned node-adapter listens on (proxy upstream). */
  dbSyncInternalPort: number;
  /** Directory where node-adapter persists SQLite + assets. */
  dataDir: string;
}

export interface HyphaRuntime extends HyphaConfig {
  signingPrivateKey: KeyLike;
  signingPublicJwk: JWK;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

/**
 * Parse env into config + generate an ephemeral RS256 keypair.
 *
 * M1 ships ephemeral keys: each server restart invalidates outstanding JWTs.
 * That is acceptable because Phase-1 DoD is page-reload persistence (the
 * session cookie + /auth/session round-trip), not server-restart persistence.
 * Volume-backed key storage moves to M3.
 */
export async function loadConfig(): Promise<HyphaRuntime> {
  const config: HyphaConfig = {
    port: Number(envOr("PORT", "3000")),
    host: envOr("HOST", "0.0.0.0"),
    username: envOr("HYPHA_USERNAME", "hypha-user"),
    email: envOr("HYPHA_USER_EMAIL", "user@hypha.local"),
    accessCodeHash: requireEnv("HYPHA_ACCESS_CODE_HASH"),
    jwtIssuer: requireEnv("HYPHA_JWT_ISSUER"),
    jwtAudience: requireEnv("HYPHA_JWT_AUDIENCE"),
    jwtTtl: envOr("HYPHA_JWT_TTL", "30d"),
    sessionTtlSeconds: Number(envOr("HYPHA_SESSION_TTL_SECONDS", "2592000")),
    cookieSecure: envOr("HYPHA_COOKIE_SECURE", "false") === "true",
    signingKid: envOr("HYPHA_SIGNING_KID", "hypha-key-1"),
    staticDirs: [],
    dbSyncInternalPort: Number(envOr("HYPHA_DB_SYNC_PORT", "8787")),
    dataDir: requireEnv("HYPHA_DATA_DIR"),
  };

  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = config.signingKid;
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";

  return {
    ...config,
    signingPrivateKey: privateKey,
    signingPublicJwk: publicJwk,
  };
}

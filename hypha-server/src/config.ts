/**
 * Hypha-server runtime configuration.
 *
 * Pure env-var parsing + ephemeral key material generation.
 * Loaded once at process start by buildApp().
 *
 * Fail-fast: required env vars throw on load. We do NOT mask missing config
 * with defaults (per AGENTS.md "Error handling and compatibility").
 */

import { generateKeyPair, exportJWK, SignJWT, type JWK, type KeyLike } from "jose";

export interface HyphaConfig {
  port: number;
  host: string;
  /** Stable username burned into JWTs for the single-user Phase-1 setup. */
  username: string;
  /**
   * UUID-formatted JWT `sub` claim. Logseq's worker pipeline calls
   * `(uuid (:sub decoded-id-token))` to materialize a per-user "created-by"
   * page in the graph database; that page's :block/uuid then flows into
   * the search index, which strictly validates UUID format. A non-UUID
   * `sub` like "hypha-user" breaks search-upsert with
   * "Search upsert-blocks wrong data" inside the db-worker.
   *
   * Default is a synthetic Phase-1 single-user UUID. Override via
   * HYPHA_USER_UUID if you ever need to migrate identities.
   */
  userUuid: string;
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

/** bcrypt hash as produced by bin/hypha-gen-access-hash (60 chars). */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function requireBcryptHash(name: string, value: string): string {
  if (!BCRYPT_HASH.test(value)) {
    // bcrypt.compare() answers false for anything else, so every login
    // would fail with "invalid access code" and nothing would say why. The
    // usual cause is an unquoted hash in .env: docker compose expands the
    // "$2b$12$..." segments as variables.
    throw new Error(
      `${name} is not a bcrypt hash (expected 60 characters starting with $2a$/$2b$/$2y$). ` +
        `In .env, quote it with single quotes: ${name}='$2b$12$...'`,
    );
  }
  return value;
}

function parseIntEnv(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min} (got "${value}")`);
  }
  return n;
}

function parseBoolEnv(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false" (got "${value}")`);
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
    port: parseIntEnv("PORT", envOr("PORT", "3000"), 0),
    host: envOr("HOST", "0.0.0.0"),
    username: envOr("HYPHA_USERNAME", "hypha-user"),
    userUuid: envOr("HYPHA_USER_UUID", "00000000-0000-0000-0000-000000000001"),
    email: envOr("HYPHA_USER_EMAIL", "user@hypha.local"),
    accessCodeHash: requireBcryptHash("HYPHA_ACCESS_CODE_HASH", requireEnv("HYPHA_ACCESS_CODE_HASH")),
    jwtIssuer: requireEnv("HYPHA_JWT_ISSUER"),
    jwtAudience: requireEnv("HYPHA_JWT_AUDIENCE"),
    jwtTtl: envOr("HYPHA_JWT_TTL", "30d"),
    sessionTtlSeconds: parseIntEnv(
      "HYPHA_SESSION_TTL_SECONDS",
      envOr("HYPHA_SESSION_TTL_SECONDS", "2592000"),
      1,
    ),
    cookieSecure: parseBoolEnv("HYPHA_COOKIE_SECURE", envOr("HYPHA_COOKIE_SECURE", "false")),
    signingKid: envOr("HYPHA_SIGNING_KID", "hypha-key-1"),
    staticDirs: [],
    dbSyncInternalPort: parseIntEnv("HYPHA_DB_SYNC_PORT", envOr("HYPHA_DB_SYNC_PORT", "8787"), 0),
    dataDir: requireEnv("HYPHA_DATA_DIR"),
  };

  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = config.signingKid;
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";

  // An invalid HYPHA_JWT_TTL would otherwise only fail at the first login.
  try {
    await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setExpirationTime(config.jwtTtl)
      .sign(privateKey);
  } catch {
    throw new Error(`HYPHA_JWT_TTL is not a valid duration (got "${config.jwtTtl}", e.g. "30d" or "1h")`);
  }

  return {
    ...config,
    signingPrivateKey: privateKey,
    signingPublicJwk: publicJwk,
  };
}

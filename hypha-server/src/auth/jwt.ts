/**
 * Hypha-JWT signer.
 *
 * Output is consumed by deps/db-sync's verify-jwt
 * (deps/common/src/logseq/common/authorization.cljs), which checks:
 *   - alg: RS256
 *   - iss: matches COGNITO_ISSUER (we map HYPHA_JWT_ISSUER → COGNITO_ISSUER)
 *   - aud or client_id: matches COGNITO_CLIENT_ID
 *   - exp: in the future
 *   - signature: against JWKS_URL (we serve /auth/jwks)
 *
 * Claim shape — V1-(c) defensive double-claim:
 *   "cognito:username" and "preferred_username" carry the same value, so
 *   downstream consumers reading either key keep working if upstream renames.
 *   Current consumer (deps/db-sync/src/logseq/db_sync/index.cljs:340) reads
 *   "cognito:username" without a fallback. The dual claim shields us from a
 *   future upstream rename without consuming patch budget.
 */

import { SignJWT, jwtVerify, importJWK } from "jose";
import type { HyphaRuntime } from "../config.js";

export async function signHyphaJwt(config: HyphaRuntime): Promise<string> {
  return await new SignJWT({
    "cognito:username": config.username,
    "preferred_username": config.username,
    email: config.email,
    name: config.username,
  })
    .setProtectedHeader({ alg: "RS256", kid: config.signingKid })
    // sub is a UUID-formatted string. Logseq's worker pipeline takes it
    // through (uuid sub) to materialize the created-by user page, whose
    // :block/uuid must pass the search index's UUID-format validator
    // (deps/common/src/logseq/common/util.cljs uuid-string?). A non-UUID
    // value here breaks graph persistence with a cryptic "Search
    // upsert-blocks wrong data" error from the db-worker.
    .setSubject(config.userUuid)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setExpirationTime(config.jwtTtl)
    .setIssuedAt()
    .sign(config.signingPrivateKey);
}

/**
 * Verify a Hypha-issued JWT.
 *
 * Used by routes hypha-server serves itself (currently /capture); the
 * proxied db-sync routes verify independently against /auth/jwks.
 *
 * Signing keys are regenerated on every container start, so tokens from a
 * previous run fail here. That is intended: clients treat 401 as "log in
 * again with the access code" rather than a hard error.
 */
export async function verifyHyphaJwt(token: string, config: HyphaRuntime): Promise<boolean> {
  try {
    const publicKey = await importJWK(config.signingPublicJwk, "RS256");
    await jwtVerify(token, publicKey, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    return true;
  } catch {
    return false;
  }
}

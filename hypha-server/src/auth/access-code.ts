/**
 * Access-code verification.
 *
 * Phase-1 single-user setup: one bcrypt-hashed access code in env, verified
 * against the supplied plaintext code from POST /auth/login.
 *
 * bcryptjs is used (not native bcrypt) so the container image stays free of
 * platform-specific build steps. bcryptjs is pure-JS, ~2x slower than native;
 * for an interactive login that runs once per session this is irrelevant.
 */

import bcrypt from "bcryptjs";

export function verifyAccessCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}

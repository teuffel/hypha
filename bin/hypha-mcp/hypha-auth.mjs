#!/usr/bin/env node
// Hypha auth driver.
//
// Exchanges the Hypha access code for a short-lived id-token (JWT) via
// hypha-server's POST /auth/login, then writes it into the logseq CLI's
// auth.json. The CLI's resolve-auth! reads that file and, because the token
// is not expired, returns it directly WITHOUT any Cognito call. That id-token
// is what the db-worker-node RTC client presents to the node-adapter (verified
// via JWKS), so the headless writer authenticates exactly like a browser.
//
// Run this once before `hypha-sync-up.sh`, and re-run it (plus re-push via the
// sync flow) before the token expires (~1h) for long sessions.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

const HYPHA_URL = process.env.HYPHA_URL ?? "https://notes.teuffel.io";
const CODE_FILE = process.env.HYPHA_ACCESS_CODE_FILE ?? join(homedir(), ".config", "hypha", "access-code");
const AUTH_PATH = join(homedir(), "logseq", "auth.json");

function fail(msg) {
  console.error(`hypha-auth: ${msg}`);
  process.exit(1);
}

let code;
try {
  code = readFileSync(CODE_FILE, "utf8").trim();
} catch {
  fail(`cannot read access code at ${CODE_FILE} (create it with your Hypha access code)`);
}
if (!code) fail(`access code file ${CODE_FILE} is empty`);

const res = await fetch(`${HYPHA_URL}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code }),
});

if (!res.ok) {
  const body = await res.text().catch(() => "");
  fail(`login failed: HTTP ${res.status} ${body}`);
}

const data = await res.json();
const idToken = data["id-token"];
if (!idToken) fail(`login response missing id-token: ${JSON.stringify(data)}`);

// Decode exp from the JWT payload (base64url) to set expires-at.
const payloadB64 = idToken.split(".")[1];
const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
const expiresAt = typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 3600_000;

const authData = {
  provider: "hypha",
  "id-token": idToken,
  "expires-at": expiresAt,
  sub: claims.sub ?? null,
  email: claims.email ?? null,
  "updated-at": Date.now(),
};

mkdirSync(join(homedir(), "logseq"), { recursive: true });
writeFileSync(AUTH_PATH, JSON.stringify(authData, null, 2), "utf8");
try { chmodSync(AUTH_PATH, 0o600); } catch {}

const minsLeft = Math.round((expiresAt - Date.now()) / 60000);
console.log(`hypha-auth: wrote ${AUTH_PATH} (sub=${claims.sub ?? "?"}, expires in ~${minsLeft} min)`);

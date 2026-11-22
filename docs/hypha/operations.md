# Hypha Operations

How to deploy and operate a Hypha instance.

This document is the operator's manual. For architecture see
[phase-1-plan.md](phase-1-plan.md); for self-hosting tutorial-style steps
(future) see `self-hosting.md` (added in M4).

## Prerequisites

- Docker 24+ and Docker Compose v2.
- ~500 MB free disk for the image, plus whatever space you want to give your
  graphs (SQLite + assets in `./data`).
- A way to type at a terminal for the one-time access-code setup.

## First-run setup

```bash
# 1. Clone the Hypha source (or download a release tarball)
git clone https://github.com/teuffel/hypha.git
cd hypha

# 2. Generate an access code + hash. The plaintext is what you'll type at
#    the login modal; the hash goes in .env. Save the plaintext somewhere
#    safe (password manager) — it's never recoverable from the hash.
bin/hypha-gen-access-hash

# 3. Configure environment. Copy the template and edit it. Paste the hash
#    line from step 2 verbatim — single quotes around the hash are required
#    because bcrypt output contains '$' which docker-compose otherwise
#    interprets as variable references.
cp .env.example .env
$EDITOR .env

# 4. Prepare the data directory. The container runs as UID 1000 ('node');
#    the data directory must be writable by that UID.
mkdir -p data
sudo chown 1000:1000 data   # only needed if your host UID isn't 1000

# 5. Build the image + start the stack.
docker compose -f docker-compose.hypha.yml up --build
```

When the container reports `hypha-server listening on 0.0.0.0:3000`, open
`http://localhost:3000` in a browser. You'll get the Hypha access-code login
modal. Type the **plaintext** from step 2.

For a reverse-proxy setup (recommended for any non-localhost deployment):
front Hypha with Caddy, nginx, or Traefik on TLS. When TLS is in front,
set `HYPHA_COOKIE_SECURE=true` and `HYPHA_JWT_ISSUER=https://your.host` in
`.env` and restart. (TLS termination + Caddy example will land in M4.)
If you use marketplace plugins, also give the plugin listener its own
hostname — see [Plugin origin](#plugin-origin).

## Plugin origin

Marketplace plugins are third-party code that runs in iframes. Hypha proxies
the plugin files (the upstream bucket lacks the headers a cross-origin
isolated page requires), but serves them from a **second listener with its
own origin** — never from the app's origin. A plugin document that shared
the app origin could call `GET /auth/session` with your session cookie,
obtain a JWT, and read every graph.

| Variable | Where | Meaning |
|---|---|---|
| `HYPHA_PLUGIN_HOST_PORT` | `.env` (compose) | Host port for the plugin listener. Default `3010`. |
| `HYPHA_PLUGIN_ORIGIN` | `.env` | Full public origin of the plugin listener, for reverse-proxy setups. Overrides the port. |
| `HYPHA_PLUGIN_PORT` | container | Port the listener binds inside the container. Default `3010`; rarely changed. |
| `HYPHA_PLUGIN_PUBLIC_PORT` | container | Port the browser uses. Compose sets it from `HYPHA_PLUGIN_HOST_PORT`. |

**Port mode (default).** The browser loads plugin iframes from
`<same scheme>://<same hostname>:3010`. Nothing to configure on localhost
or a LAN — the port just has to be reachable from the browser. It is
published on the same address as the app port (`HYPHA_BIND`, loopback by
default), so `HYPHA_BIND=0.0.0.0` for LAN access exposes both.

**Reverse-proxy mode.** Give the plugin listener its own hostname and
point it at container port 3010:

```
hypha.example.com          → hypha:3000
plugins.hypha.example.com  → hypha:3010
```

```bash
HYPHA_JWT_ISSUER=https://hypha.example.com
HYPHA_PLUGIN_ORIGIN=https://plugins.hypha.example.com
```

Rules:

- The plugin origin **must differ** from the app origin. hypha-server
  refuses to start when `HYPHA_PLUGIN_ORIGIN` equals the origin of
  `HYPHA_JWT_ISSUER`, and the frontend refuses to load plugins from its own
  origin.
- Do **not** route `/plugin-cdn/assets/*` on the app hostname to port 3010
  ("to save a hostname"). That recreates the same-origin problem.
- A separate hostname isolates better than a separate port: cookies are not
  port-scoped, so in port mode the browser attaches the (HttpOnly) session
  cookie to requests for the plugin listener. The listener ignores it and
  plugin scripts cannot read it, but with a separate hostname it is never
  sent at all.
- If the plugin origin is unreachable or unset, plugins fail with a
  handshake timeout and the console logs
  `[hypha] no separate plugin-assets origin configured`. The app itself is
  unaffected.

This restores the isolation stock Logseq has (plugin iframe is cross-origin
and talks to the app through `postMessage`). It does not sandbox the plugin
API itself: an installed plugin can still read and modify the open graph
through that API, exactly as in upstream Logseq. Only install plugins you
trust.

## Routine operation

```bash
# Foreground — see logs in real time
docker compose -f docker-compose.hypha.yml up

# Background
docker compose -f docker-compose.hypha.yml up -d

# Tail logs
docker compose -f docker-compose.hypha.yml logs -f

# Stop (graceful: SIGTERM, app.close, runner.stop, then exit)
docker compose -f docker-compose.hypha.yml down

# Restart (rebuilds nothing; just bounces the container)
docker compose -f docker-compose.hypha.yml restart
```

Restarting the container loses outstanding JWTs (the RS256 signing key is
ephemeral in Phase 1 — see phase-1-plan.md M3 scope). Browser users will
see a login modal on their next request and re-authenticate with the
access code. The HttpOnly session cookie is still in the browser, so the
re-login is one click away (no code re-entry needed if the session cookie
hasn't expired).

## Backup

Everything persistent lives in `./data/`:

```
data/
├── <graph-id>/
│   ├── db.sqlite        # graph datascript snapshot
│   ├── tx-log.sqlite    # transaction log
│   └── assets/          # binary attachments
├── index.sqlite         # graph index + access control
└── sessions.json        # in-Phase-1 still in-memory; persistence M4
```

Plain `rsync` / `tar` / `restic` against `./data` is sufficient. Hypha
holds open file descriptors on the SQLite files, so for a consistent
snapshot prefer one of:

- Stop the container first (`docker compose ... down`) and copy.
- Use SQLite's online-backup mechanism (future helper in M4).
- Or accept eventual-consistency from rsync — the worst case is that a
  half-written transaction is rolled back on next start, not data loss.

## Upgrade

There are two ways to run Hypha, and therefore two upgrade paths.

### A. Published image (recommended)

Pull a versioned image from GHCR — no local build toolchain needed. Use
`docker-compose.hypha.prod.yml`, which references
`ghcr.io/teuffel/hypha:${HYPHA_VERSION:-latest}`:

```bash
cd hypha
# 1. Back up first — see Backup section above.
docker compose -f docker-compose.hypha.prod.yml down

# 2. Pin the new version (recommended for real data) and pull.
export HYPHA_VERSION=v0.1.6.2
docker compose -f docker-compose.hypha.prod.yml pull

# 3. Start.
docker compose -f docker-compose.hypha.prod.yml up -d
```

Pinning an immutable `vX.Y.Z` tag (rather than `latest`) makes upgrades a
deliberate act and lets you roll back by setting `HYPHA_VERSION` to the
previous tag. Each GitHub Release states the Logseq DB schema version it
carries; if its MAJOR component changed, graphs auto-migrate forward on
first open and every device must run the new version or newer to keep
syncing — so back up `./data` and upgrade all devices together.

### B. Build from source

```bash
cd hypha
git pull
docker compose -f docker-compose.hypha.yml up --build -d
```

Either path is idempotent; existing data in `./data` is untouched. On boot
the new container will pick up the existing SQLite files. Outstanding
JWTs are invalidated by the restart (ephemeral signing key).

### Cutting a release (maintainer)

Releases are produced by `.github/workflows/hypha-release.yml` on any `v*`
tag. The workflow builds the image, smoke-tests it (`/health` + access-code
login) and only then pushes `vX.Y.Z` + `vX.Y` + `latest` to GHCR, finally
opening a GitHub Release.

```bash
git tag v0.1.6.2
git push origin v0.1.6.2
```

After the first release, set the GHCR package visibility to Public once
(GitHub → Packages → hypha → Package settings → Change visibility), so
consumers can `docker pull` without authenticating.

## Troubleshooting

### Container exits with "Missing required environment variable: ..."

Hypha fails fast when required env vars are missing. Check `.env` is in
the working directory and has at least `HYPHA_ACCESS_CODE_HASH` set.
Compose prints which variable is unset.

### Container can't write to /data

```
Error: EACCES: permission denied, open '/data/index.sqlite'
```

The container runs as UID 1000 (the `node` user in the image). Your host
`./data` must be writable by UID 1000:

```bash
sudo chown -R 1000:1000 data
```

Alternatively override the container UID in `docker-compose.hypha.yml`:

```yaml
    user: "${HOST_UID}:${HOST_GID}"
```

with `HOST_UID=$(id -u) HOST_GID=$(id -g)` in `.env`.

### Login modal accepts the code but the page reloads to a blank screen

This is usually a CORS / mismatched-origin issue when accessing Hypha
through a reverse proxy. Check that `HYPHA_JWT_ISSUER` matches the
URL the browser actually loaded Hypha from (https vs http, hostname),
and that `HYPHA_COOKIE_SECURE=true` is set when behind TLS.

### "node-adapter did not become ready within 30000ms"

The hypha-server gave up waiting for the db-sync child to print its
ready line. Causes:

- The data directory exists but isn't writable — see EACCES above.
- The SQLite better-sqlite3 native binary fails to load. Inspect with:
  ```bash
  docker compose -f docker-compose.hypha.yml run --rm hypha \
    node -e "require('better-sqlite3')"
  ```
  No output = it loads; an error stack tells you what's wrong. The
  prebuilt binary in the image targets x64 Linux glibc 2.31+; if your
  host's container runtime exposes a more exotic ABI (musl, ARM), rebuild
  the image with `--build-arg` for that target (post-M4 helper).

## Phase-1 limitations (known)

- Signing keys are ephemeral; every container restart invalidates issued
  JWTs. M4 introduces volume-backed key storage.
- Single user only. The access code grants whoever knows it the single
  `hypha-user` identity baked into the JWT.
- Sessions are in-memory; if you want sessions to survive container
  restart, lift them to JSON-on-disk (future M4 helper).
- No realtime collab (Phase 2 territory).

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

```bash
cd hypha
git pull
docker compose -f docker-compose.hypha.yml up --build -d
```

The build is idempotent; existing data in `./data` is untouched. On boot
the new container will pick up the existing SQLite files. Outstanding
JWTs are invalidated by the restart (ephemeral signing key).

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

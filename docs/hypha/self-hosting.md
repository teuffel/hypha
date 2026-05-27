# Self-hosting Hypha

A 10-minute walkthrough for getting your own Hypha instance running on a
machine you control. If you've ever run `docker compose up`, you have all
the skills needed.

If you're looking for a reference instead of a tutorial,
[operations.md](operations.md) is the cookbook. If you want to know how
Hypha is built and why, [phase-1-plan.md](phase-1-plan.md) is the
architecture document.

## What you'll get

- A self-contained Logseq DB-flavour web app served from your own machine.
- Your data lives in plain SQLite files on your disk, not a third-party
  cloud.
- One-person access via an access code you set.
- **Multi-device for the same user**: type the access code in Firefox on
  your laptop, again in Chrome on your desktop, and you see the same
  graphs in both. New graphs default to cloud-sync; toolbar buttons let
  you upload pre-existing local graphs at any time.
- No realtime collaboration (that's Phase 2 territory — two browsers
  editing live and seeing each other's cursor). What works today is
  sequential: edit in one device, switch to another, the changes are
  there.

## What you'll need

- A machine that can run Docker. Linux or macOS, x86_64 or ARM.
  Tested in CI on Ubuntu 22.04 / x86_64.
- ~1 GB free disk for the image, plus whatever space you want to give
  your graphs.
- 5 minutes of attention for the first build, then it's hands-off.

You do **not** need:
- Node.js, pnpm, Clojure, or Java on your host. Everything lives inside
  the Docker image.
- A domain name or TLS certificate (for a localhost-only setup).
- An external auth provider, OAuth flow, or "sign up" page.

## Step 1: Clone

```bash
git clone https://github.com/teuffel/hypha.git
cd hypha
```

## Step 2: Generate an access code

Hypha is single-user. The "user" is anyone who knows the access code.
Generate a random one + its bcrypt hash with the bundled helper:

```bash
bin/hypha-gen-access-hash
```

Output looks like:

```
── Hypha access code ───────────────────────────────────────
Plaintext (save in a password manager — you'll type this at login):
  4a8d2e51bf6c92...

Add this line to .env (single quotes required — bcrypt hashes
contain '$' which docker-compose otherwise interprets as a
variable reference):

  HYPHA_ACCESS_CODE_HASH='$2b$12$abc...'
─────────────────────────────────────────────────────────────
```

**Save the plaintext** in a password manager. You'll type it at the
login modal every time you set up a fresh browser. The hash is what
goes into `.env`.

> If you'd rather choose your own code, run
> `bin/hypha-gen-access-hash my-chosen-code` instead. Your code only
> needs to be unguessable; length and characters are up to you.

## Step 3: Configure

```bash
cp .env.example .env
$EDITOR .env
```

Paste the `HYPHA_ACCESS_CODE_HASH='...'` line from step 2 verbatim. The
single quotes matter — bcrypt hashes contain `$` which docker-compose
otherwise interprets as variable substitution.

For a localhost-only setup, the defaults for the other variables are
fine. If you'll expose Hypha to the network (a different machine or the
internet), see "Step 6: Going further" below.

## Step 4: Prepare data directory

Hypha persists everything (SQLite databases, assets) under `./data`. It
needs to be writable by the `node` user inside the container, which is
UID 1000:

```bash
mkdir -p data
# Only needed if your host user isn't UID 1000:
sudo chown 1000:1000 data
```

## Step 5: Build + run

```bash
docker compose -f docker-compose.hypha.yml up --build
```

The first build takes ~5 minutes (downloading base images, installing
build tools, compiling ClojureScript + TypeScript, bundling the
frontend). Subsequent runs reuse cached layers and finish in seconds.

When you see

```
hypha-server listening on 0.0.0.0:3000
```

open <http://localhost:3000> in your browser. The Hypha login modal
appears. Type the **plaintext** access code from step 2, hit Enter.

You're in. The interface is Logseq's DB-flavour UI; everything you do
syncs to your local `./data` SQLite files via the bundled db-sync
service.

## Step 6: Going further

### Run in the background

`Ctrl-C` to stop. To run detached:

```bash
docker compose -f docker-compose.hypha.yml up -d --build
```

`docker compose -f docker-compose.hypha.yml logs -f` follows logs.
`docker compose -f docker-compose.hypha.yml down` stops cleanly.

### Access from another device on your LAN

Edit `.env`:

```bash
HYPHA_JWT_ISSUER=http://192.168.1.42:3000   # your LAN address
```

Restart the stack. The JWT issuer matters because the browser and
server must agree on the URL used for auth tokens.

### Access from the internet (TLS strongly recommended)

Put a reverse proxy (Caddy, nginx, Traefik) on TLS in front of Hypha.
Once TLS is terminated:

```bash
HYPHA_JWT_ISSUER=https://hypha.example.com
HYPHA_COOKIE_SECURE=true
```

`Secure` on the session cookie keeps it from being sent over plain
HTTP, closing one class of attacks. A Caddy `Caddyfile` example will
land in a future Hypha release.

### Backup

`./data` is the only thing that matters. `tar` / `rsync` / `restic` it
on a schedule you're comfortable with. For a hot copy, see
[operations.md#backup](operations.md#backup).

### Upgrade

```bash
git pull
docker compose -f docker-compose.hypha.yml up -d --build
```

Your data is untouched. Outstanding login sessions are invalidated by
the restart (Phase-1 uses ephemeral JWT signing keys); re-login takes
one click of the access-code modal.

## Things that don't work yet

- **Multi-user**. The access code grants whoever knows it the single
  `hypha-user` identity. Phase 2.
- **Realtime collaboration**. Two devices editing the same graph live
  and seeing each other's cursor. Phase 2.
- **Automatic E2EE key sync**. Hypha defaults to E2EE-off because a
  password-encrypted private key would need re-entry on every device.
  You can still flip the E2EE checkbox per graph manually — but then
  you take responsibility for typing the same E2EE password on each
  device. Recovery-phrase-based automatic sync is Phase 2.
- **Mobile apps**. The Hypha frontend is a regular web app; Capacitor
  mobile clients are not built in M0-M10.
- **Persistent JWT signing keys across container restarts**. Phase 1
  uses ephemeral keys; a restart invalidates outstanding sessions but
  the HttpOnly cookie lets re-login happen in one click. Phase 2.

## Where to ask for help

- Repository issues: <https://github.com/teuffel/hypha/issues>
- For Logseq-specific questions (not Hypha-specific): the upstream
  Logseq forum / Discord remains the right place.

## Phase-1 design notes

Phase-1 keeps a strict patch budget (2 upstream Mini-Hooks) so Hypha
can mechanically follow Logseq's master with a weekly merge action. See
[phase-1-plan.md](phase-1-plan.md) section 8 if you're curious how the
sync strategy works.

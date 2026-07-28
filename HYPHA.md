# Hypha

A self-hostable single-user fork of [Logseq](https://github.com/logseq/logseq)
DB-flavor. Run your own Logseq personal cloud on a machine you control,
with cross-device sync and the official plugin marketplace, in one
`docker compose up`.

For the upstream Logseq project (multi-user, hosted by the Logseq team),
see https://github.com/logseq/logseq. This fork is for people who want
the same app on their own server.

## What Hypha adds on top of upstream Logseq

| | |
|---|---|
| **One-command deploy** | `docker compose -f docker-compose.hypha.yml up` — single container, your data in `./data/` |
| **Access-code auth** | One shared access code per server; no Cognito, no OAuth, no signup flow. HttpOnly session cookie + in-memory JWT |
| **Cross-device personal cloud** | Same access code from a different browser → same graphs, sync via the upstream RTC layer |
| **Plugin marketplace** | Phase 1.5 caching reverse-proxy for the Logseq marketplace + R2 plugin assets, with CORP-header injection so iframes pass Hypha's required COEP gate |
| **Asset cache eviction** | Phase 1.6.1 background LRU eviction of cached asset binaries (`navigator.storage.estimate` + IDB cleanup) |
| **Installable PWA + quick capture** | Web manifest so the instance installs as a real app, plus an Android share target and a desktop bookmarklet that drop links into today's journal ([quick-capture.md](docs/hypha/quick-capture.md)) |
| **Upload-failure visibility** | Cloud-upload errors surface as user notifications instead of silent spinners |
| **0 backend services** | No Postgres, no Redis, no managed Cloudflare deployment — just node + sqlite in one container |

## Quick start

### Run the published image (recommended — no build toolchain)

```bash
git clone https://github.com/teuffel/hypha.git
cd hypha
cp .env.example .env              # then edit HYPHA_ACCESS_CODE_HASH
mkdir -p data
export HYPHA_VERSION=v0.1.6.2     # pin a release; omit to use :latest
docker compose -f docker-compose.hypha.prod.yml pull
docker compose -f docker-compose.hypha.prod.yml up -d
# open http://localhost:3000
```

Images are published to `ghcr.io/teuffel/hypha` per release tag (see
[Releases](https://github.com/teuffel/hypha/releases)).

### Build from source (alternative)

```bash
docker compose -f docker-compose.hypha.yml up --build
```

Full 10-minute walkthrough: [`docs/hypha/self-hosting.md`](docs/hypha/self-hosting.md).

## Documentation

| Audience | Doc |
|---|---|
| First-time operator | [`docs/hypha/self-hosting.md`](docs/hypha/self-hosting.md) — clone → access code → docker compose up |
| Day-2 operator | [`docs/hypha/operations.md`](docs/hypha/operations.md) — env vars, JWT/cookie model, backup, logs |
| Phase plans + architecture | [`docs/hypha/phase-1-plan.md`](docs/hypha/phase-1-plan.md) — Single-user personal cloud (Phase 1) |
| | [`docs/hypha/phase-1.5-plugin-marketplace.md`](docs/hypha/phase-1.5-plugin-marketplace.md) — Plugin proxy + window.apis shims |
| | [`docs/hypha/phase-1.6-cross-device.md`](docs/hypha/phase-1.6-cross-device.md) — Cross-device sync |
| | [`docs/hypha/phase-1.6.1-asset-cache.md`](docs/hypha/phase-1.6.1-asset-cache.md) — OPFS/IDB asset LRU eviction |
| | [`docs/hypha/phase-1.6.2-plugin-iframe-corp.md`](docs/hypha/phase-1.6.2-plugin-iframe-corp.md) — Plugin-iframe CORP proxy |
| | [`docs/hypha/asset-lazy-loading.md`](docs/hypha/asset-lazy-loading.md) — Asset-loading architecture |
| Patch inventory | [`HYPHA_PATCHES.md`](HYPHA_PATCHES.md) — every upstream-Logseq line Hypha modifies, with rationale + break signals |
| Build pipeline | [`bin/hypha-build`](bin/hypha-build) (`--release` for prod) — single entry point for cljs + db-sync adapter + hypha-server |
| Tests | `hypha-server/test/` (vitest + Playwright + shell smoke); upstream Logseq tests still run via `bb dev:lint-and-test` |

## Architecture in one paragraph

The browser bundle is **stock Logseq DB-flavor with a small Hypha layer**
(`src/main/frontend/hypha/`) bolted on for auth + plugin-asset rewriting.
A new TypeScript service, **`hypha-server`**, sits in front of the
upstream **`db-sync` node-adapter** as a reverse-proxy on port 3030:
auth (access-code login + JWT minting + JWKS), plugin-marketplace
caching, plugin-asset CORP-injection, and pass-through of every
`/sync/`, `/graphs/`, `/assets/`, `/e2ee/` route to the node-adapter on
loopback 8787. SQLite lives in `/data` (bind-mounted), the JWT signing
keys are ephemeral (regenerated per container start). All of the
above runs in **one** `node` process inside one `docker` image.

## Relationship to upstream Logseq

Hypha is a **soft fork**: the upstream Logseq source tree is preserved
in full and updated periodically via merge. Hypha-specific changes are
either additive (new files in `hypha-server/`, `src/main/frontend/hypha/`,
`docs/hypha/`, `bin/hypha-*`) or surgical patches against upstream code.
Every patch line is inventoried in [`HYPHA_PATCHES.md`](HYPHA_PATCHES.md)
with rationale and a structural-break detection grep, so upstream-sync
merges flag patches that need re-anchoring.

As of this commit the inventory stands at **9 of a self-imposed 20-patch
soft cap** (45 %). Beyond ~50 % the project would refactor the
interception strategy instead of adding more touch-points.

## Issues, PRs, support

- **Hypha-specific bugs and PRs** → this repo's issues + pull requests.
- **Logseq core bugs** (anything you would also see in stock Logseq) →
  please file at https://github.com/logseq/logseq/issues. Reproducing
  against upstream first helps both projects.
- **No Discord / forum** for Hypha. Per-instance, single-user; the
  surface is small.

## License

Same as upstream Logseq: [GNU Affero General Public License v3](LICENSE.md).

In short: you can self-host Hypha freely, modify it, redistribute it.
If you offer it as a network service to others (AGPL §13), you must
make the source available to those users — pointing them at this
GitHub repository satisfies that. The Hypha-layer modifications carry
the same license; the per-line inventory in [`HYPHA_PATCHES.md`](HYPHA_PATCHES.md)
acts as the AGPL §5(b) "modified versions must carry prominent notices"
declaration.

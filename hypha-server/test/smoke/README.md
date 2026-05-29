# Smoke tests

Shell scripts that exercise a **running** hypha-server end-to-end via HTTP.
Distinct from `../*.test.ts` (vitest, mock-upstream) and `../playwright/`
(Playwright, fake-adapter): smoke tests target a real container and verify
the production-bundle behavior under realistic conditions.

## Available smokes

| Script | Demonstrates | Run time |
|---|---|---|
| `cross-device-import-sync.sh` | Phase 1.6 user stories U1, U3, U4, U6: cloud-graph create + asset upload + cross-device read. Maps to "user imports a folder, clicks cloud-upload, opens app on second device, sees notes." | ~3 s |

## Running

The scripts assume a hypha-server reachable on `$HYPHA_BASE_URL`
(default `http://localhost:3030`). `HYPHA_ACCESS_CODE` is **required** and
has no default — set it to the plaintext code whose bcrypt hash the target
server was started with (never hardcode a real code in a tracked file).

```bash
# Against the dev container (docker-compose.dev.yml uses the bcrypt hash of "dev")
HYPHA_ACCESS_CODE=dev \
./hypha-server/test/smoke/cross-device-import-sync.sh

# Custom base + code (CI / remote deploy)
HYPHA_BASE_URL=http://localhost:13000 \
HYPHA_ACCESS_CODE=ci-dev-code \
./hypha-server/test/smoke/cross-device-import-sync.sh
```

## Dependencies

Each script needs `curl`, `jq`, `base64`, `head`, `sha256sum`, and a `date`
that accepts `+%s`. All standard on Linux dev hosts and GitHub-runner
images.

## When to extend

Add a new shell script here when:

- the behavior under test requires a real container (real
  `node-adapter`, real SQLite, real `/data` volume),
- vitest mocks would hide the production bundle's behavior,
- a Playwright spec is overkill (no UI interaction needed),
- you want a fast `bash`-friendly diagnosis tool that's also runnable
  by operators in a production deploy.

Place reusable curl/jq helpers inline in the script — these are smoke
tests, not a framework.

# Repository Guidelines

Logseq is a ClojureScript codebase compiled by `shadow-cljs` into multiple targets defined in `shadow-cljs.edn`: browser apps (`:app`, `:mobile`, `:publishing`), web worker (`:db-worker`), and node scripts (`:db-worker-node`, `:logseq-cli`, `:electron`, `:test`, `:test-no-worker`). `CODEBASE_OVERVIEW.md` and `docs/dev-practices.md` are the canonical orientation docs.

## Codebase Layout (non-obvious)
- `deps/` holds independent Clojure local-root libraries (`common`, `db`, `db-sync`, `graph-parser`, `outliner`, `publishing`, `publish`, `cli`, `shui`). Each has its own `deps.edn`, `.clj-kondo/`, and sometimes `package.json` / `bb.edn`. Edit the dep that owns the namespace and run that dep's tooling — not the root one.
- `src/main/frontend/worker/**` and `src/main/frontend/worker_common/**` must NOT require frontend namespaces (except `frontend.worker.*` / `frontend.common.*`); the reverse is also forbidden (one tiny allowlist for `frontend.worker.file.reset`). `bb lint:worker-and-frontend-separate` enforces both directions — a stray `:require` that pulls React into the worker breaks it hard. Shared code goes through `deps/` or `frontend.common.*`.
- Subdirectories with their own `AGENTS.md` (read recursively before editing): `src/main/logseq/cli/`, `clj-e2e/`, `cli-e2e/`, `libs/guides/`.

## Build, Test, and Development Commands
- **Run build/test/lint inside the dev container** (canonical path; the host needs only Docker + Compose). `bin/dev <command>` forwards into the `Dockerfile.dev` image whose toolchain is pinned to CI (Node 24, Java 21, Clojure CLI, Babashka, pnpm). Examples: `bin/dev bb dev:lint-and-test`, `bin/dev bb dev:test -r <regex>`, `bin/dev bin/hypha-build`. The first run builds the image (~5 min) and installs deps; later runs are instant. See `Dockerfile.dev` and `docker-compose.dev.yml`.
  - Why this matters for tests: the `:test` / `:test-no-worker` builds import `node:sqlite`, a Node 22.5+ built-in. On a host with older Node (e.g. 20.x), `pnpm cljs:run-test` / `node static/tests.js` fail at module load with `No such built-in module: node:sqlite` **before any test runs** — an environment issue, not a code failure. Run tests in the container (Node 24), not on an older-Node host.
- `bb dev:lint-and-test` runs linters and unit tests; use it before submitting changes.
- `bb dev:test -v <namespace/testcase-name>` runs a single unit test (example: `bb dev:test -v logseq.some-test/foo`). Each invocation recompiles `static/tests.js` first; for tight loops run `clojure -M:test watch test` once and then `node static/tests.js -v <ns/test>` (or `-r <regex>`, `-i focus`, etc. — see `docs/dev-practices.md`).
- App E2E tests live in `clj-e2e/`; run from that directory with `bb test` (or `bb -f clj-e2e/bb.edn test` from repo root).
- CLI E2E tests live in `cli-e2e/`; run with `bb -f cli-e2e/bb.edn test` (does its own build preflight; pass `--skip-build` only to reuse existing artifacts).
- If a request says only "e2e", clarify whether it targets `clj-e2e/` or `cli-e2e/` before planning changes.
- `db-worker-node` needs both compile **and** bundle: `pnpm db-worker-node:release:bundle` (or `db-worker-node:compile:bundle` for dev). CLI E2E and the desktop runtime depend on the bundled artifact, not the bare compiled output.

## Error handling and compatibility
- When modifying code, first consider removing compatibility layers rather than extending them.
- Prefer fail-fast over fallback.
- Do not add backward compatibility unless explicitly requested.
- Do not introduce default values to mask invalid state.
- Do not silently recover from programmer errors.
- Keep one clear code path whenever possible.
- Internal code may assume well-formed inputs from controlled callers.

## Coding Style & Naming Conventions
- Shared ClojureScript keywords are declared with `logseq.common.defkeywords/defkeywords` (plural batch macro; `defkeyword` also exists). Add new shared keywords there rather than scattering literals.
- Clojure map keyword names use `-` instead of `_` (e.g. `:user-id`, not `:user_id`).
- Avoid shadowing core vars (`bytes`, `name`, etc.); prefer names like `payload`.
- Avoid `js/Buffer` in browser-related code.
- For i18n work, `.i18n-lint.toml` is the source of truth for lint scope and exceptions. Inside that scope, shipped UI text must use helpers from `frontend.context.i18n`; console text is exempt. Keep out-of-scope developer-only `(Dev)` labels inline in code/config, not in translation dictionaries.
- Reuse `src/resources/dicts/en.edn` keys only on exact semantic owner + textual role match. Follow `docs/i18n-key-naming.md` for new or renamed keys. Add English source text in `en.edn`; add non-English entries only when providing real translations; keep complete sentences whole; use placeholders for plain dynamic text; run `bb lang:validate-translations`, `bb lang:lint-hardcoded`, and `bb lang:format-dicts` as needed.

## Testing Guidelines
- Unit tests live in `src/test/` and are runnable via `bb dev:lint-and-test` (run it inside the dev container — see Build/Test commands; the test build needs Node 22.5+ for `node:sqlite`).
- A namespace's tests live in the sibling namespace with a `-test` suffix (`frontend.db.model` → `frontend.db.model-test`).
- See `docs/dev-practices.md` for repl-driven, autorun, database, performance, and async test helpers.

## *IMPORTANT*: Always respect directory-specific AGENTS.md based on file path
- When editing code in a specific directory, recursively read `AGENTS.md` files up the directory tree. Subdirectory `AGENTS.md` takes precedence over the root-level one.

## Commit & Pull Request Guidelines
- Commit subjects are short and imperative, often with a scoped prefix matching existing history: `fix:`, `feat:` / `feature:`, `enhance:` / `enhance(rtc):`, `chore:`, `dev:`, `test:`.
- PRs should describe the behavior change, link relevant issues, and note any test coverage added or skipped.

## Agent-Specific Notes
- Repo-local skills live under `.agents/skills/`; load the matching `SKILL.md` before editing files or proposing changes.
- **i18n (mandatory)**: Always load `.agents/skills/logseq-i18n/SKILL.md` before any change that adds, edits, or removes user-facing UI text, regardless of whether other skills also apply.
- Review notes in `prompts/review.md` codify recurring Clojure(Script) mistakes (`empty?` vs `empty`, `conn` vs `db`, `memoize` leaks, log helpers, `:block/title` vs deprecated `:block/content`, etc.); check them when preparing changes.
- DB-sync feature guide for AI agents: `docs/agent-guide/db-sync/db-sync-guide.md`.
- DB-sync protocol reference: `docs/agent-guide/db-sync/protocol.md`.
- For db-sync D1 schema changes, add or update a Cloudflare worker SQL migration under `deps/db-sync/worker/migrations/`; do not rely on ad hoc runtime-only schema migration code.
- New properties go in `logseq.db.frontend.property/built-in-properties` AND require a paired entry in `frontend.worker.db.migrate/schema-version->updates` (e.g. `["65.10" {:properties [:block/journal-day]}]`). Skipping the migration silently breaks existing graphs.
- Avoid creating new classes or properties unless required.
- When deleting properties in a db migration, add those properties to `logseq.db-sync.tx-sanitize/migration-deleted-attrs` so server-side tx sanitization drops them from incoming syncs.

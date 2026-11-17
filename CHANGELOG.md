# Changelog

All notable changes to the Civic-Chain Grant & Budget Auditor are recorded here.
The project follows [Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH.

## [Unreleased]

### Added — in-browser demo (S7B)
- The public demo now runs the engine **entirely in the visitor's browser**:
  no server, no proxy, no endpoint. The page reads the synthetic Town of
  Sampleton ledger, runs the three named queries with their checks, the guard,
  result hashing and the audit chain locally, and sends nothing anywhere.
  - **Shared engine, two leaves.** New `src/browser/engine.js` assembles the
    *same* engine source the Node package runs (`guard.js`, the new pure
    `named-core.js`, `lineage.js`, `audit-core.js`); only SQLite (WASM via
    sql.js, in-memory, `PRAGMA query_only`) and hashing (the new dependency-free
    `src/platform/sha256.js`) differ from Node.
  - **Parity gate.** `test/browser-parity.test.js` runs every demo case through
    both engines and asserts identical rows, checks, findings, executed SQL and
    **result hash**; `test/sha256.test.js` pins the pure SHA-256 against
    `node:crypto`.
  - **Build.** `npm run build:demo` (esbuild) emits `site/assets/demo-engine.js`
    plus the self-hosted `sql-wasm.{js,wasm}`, inlining the seed SQL and
    allow-list from the skill assets (one source of truth). ~1.0 MB transferred.
    Built files are committed, so Netlify stays build-free.
  - **Page.** `site/demo.html` runs the queries locally, shows the executed SQL,
    and adds *Reset chain* and *Tamper with an entry* controls plus a guarded
    "try your own SQL" box. A labelled sample remains for when WASM cannot load.
  - **Locked down.** `netlify.toml` serves a Content-Security-Policy
    (`script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`), verified with
    no violations by `scripts/verify-demo.mjs` (headless Chromium: engine loads,
    chain verifies/tampers/resets, guard refuses out-of-bounds SQL, zero
    network requests after load).

### Changed — engine seam (no behaviour change in Node)
- Split three Node-bound modules so their logic is pure and their I/O injected,
  with all existing tests passing unchanged: hashing moved behind
  `src/platform/hash.js` (Node `node:crypto`, browser pure SHA-256); the chain
  logic moved to pure `src/audit-core.js` (`appendEntry`/`verifyEntries`), with
  `audit.js` the file-backed, signing wrapper; the orchestration moved to pure
  `src/named-core.js`, with `named-run.js` the Node wrapper; `parseAllowlist`
  moved to pure `src/allowlist.js`. `provenanceOf` is now one shared definition.
- Rebranded the demo surface to **Civic-Chain Grant & Budget Auditor** across
  `site/` and `netlify.toml` (carries C2 into the web layer).

### Removed — the S7 hosted path
- Deleted `Dockerfile`, `.dockerignore`, `fly.toml` and `supabase/` (the Fly
  engine and Supabase edge proxy). `cc-auditor serve` stays for enterprise use
  and still refuses to start without `ENGINE_SERVICE_TOKEN`. The live Fly app,
  Supabase function and its token are torn down post-deploy per the checklist in
  `deploy/README.md`.

## [1.0.0] — 2026-11-14

**This release is the licence cut-over.** Everything published at or after the
`v1.0.0` tag is offered under the **Civic-Chain Commercial Licence** (see
`LICENSE`): source-available, right-to-use with a subscription, no
redistribution or resale. Everything published *before* this tag (the `0.x`
history, up to and including commit `88e08a3`) was offered under the MIT Licence
and stays MIT for anyone who already holds it. This change is not retroactive.

### Changed — licence (C1)
- Dropped MIT going forward; added the counsel-pending Civic-Chain Commercial
  Licence at the repository root and inside the `vanguard-core` package.
- Set `license` in `package.json` to `SEE LICENSE IN LICENSE`.
- Removed every "MIT" and "open source" claim about the engine from the docs.
  The engine is **source-available**, not open source.
- Added a copyright-header convention for new files (`COPYRIGHT.md`).

### Changed — rebrand (C2)
- Renamed the product to **Civic-Chain Grant & Budget Auditor**, retiring the
  "Vanguard" name a buyer sees. CLI display name is now `cc-auditor`.
- Environment variables are now `CIVIC_*` (`CIVIC_DB_PATH`, `CIVIC_ALLOWLIST_PATH`,
  `CIVIC_AUDIT_LOG`, `CIVIC_SIGNING_KEY[_FILE]`, `CIVIC_CORE`). The former
  `VANGUARD_*` names are honoured as a fallback for one release, then removed.
- MCP server name is `civic-chain-auditor`; resource URIs use the
  `civic-chain://` scheme; the host config key is `civic-chain-auditor`.
- Renamed the agent skill folder to `skills/civic-chain-auditor/`.

### Security (C3)
- `cc-auditor serve` (the HTTP API) now **refuses to start** unless
  `ENGINE_SERVICE_TOKEN` is set. It previously ran unauthenticated by default.

### Release hygiene (C3)
- Adopted semantic versioning starting at 1.0.0; this file is the record of what
  subscribers receive.
- Merged the engine and skill onto `main` so a fresh clone can complete setup.
- Excluded `scripts/package.sh` from the shipped skill zip.

### Deprecated
- `VANGUARD_*` environment variables. Use the `CIVIC_*` names; the aliases will
  be removed in the next minor release.

[1.0.0]: https://github.com/justin-harvey/Vanguard-MCP/releases/tag/v1.0.0

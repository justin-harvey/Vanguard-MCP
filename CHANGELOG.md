# Changelog

All notable changes to the Civic-Chain Grant & Budget Auditor are recorded here.
The project follows [Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH.

## [Unreleased]

### Added — import the buyer's CSV (S8)
- A buyer can now point the three named queries at **their own** exported
  expenditure CSV, locally, with a tamper-evident record of exactly which file
  was imported.
  - **`cc-auditor import <file.csv>`.** Two steps, on purpose. With no `--map` it
    reads the CSV's headers (and a sample of rows to confirm types) and *proposes*
    a column mapping onto the canonical schema, writing nothing. With `--map
    mapping.json` it builds the ledger, records the source hash, and runs the
    three queries. Only a confirmed mapping is ever written.
  - **Files by name, from a named folder — never pasted data.** `CIVIC_IMPORT_DIR`
    names the folder CSVs are read from; a name that escapes it (a `..` traversal
    or an absolute path) is refused before anything is opened
    (`paths.js` `resolveImportPath`, new `ImportPathError`).
  - **`src/import-csv.js`.** A zero-dependency RFC-4180 parser (a ragged row is an
    error, not a silent drop), money coerced to **integer cents** (never a float;
    accounting parentheses, `$`, thousands separators, ≤2 decimals), dates
    normalised to ISO, status mapped to paid/pending/void, fiscal year derived
    July–June. A malformed value **aborts** the import naming the row and column,
    rather than coercing to 0/null. Builds **Canonical Municipal Schema v1** with
    the derived dimension rows (vendors, departments, funds, budget lines, and any
    referenced grants) the expenditures reference, atomically (temp file + rename).
  - **Source provenance recorded.** The source file's SHA-256, byte length, row
    count and the confirmed mapping are the first entry of the imported ledger's
    own audit chain; the confirmed mapping is also saved beside the ledger
    (`mapping.json`) so an import is reviewable and reproducible.
  - **The gate.** After an import the engine runs `grant-status`,
    `spending-by-vendor` and `budget-variance` and reports each one's integrity
    and findings. A clean import answers all three with integrity `pass`.
  - **MCP tools** `propose_csv_mapping` (read-only) and `import_csv` (confirmed
    import), advertised only when `CIVIC_IMPORT_DIR` is set (so the static browser
    demo never exposes them); the file name is confined to the import folder, and
    the ledger/log/mapping paths are server-derived, never taken from the wire.
  - New `test/import-csv.test.js` (18 tests) and an anonymized, fictional
    expenditure fixture (`test/fixtures/riverton_expenditures.csv`) exercise the
    gate, money/date exactness, malformed-row rejection and path confinement.

### Added — one-line install (S6)
- The engine now publishes to npm as **`@civic-chain/auditor`** with a `bin`
  (`cc-auditor`, and `civic-chain-auditor`), a `files` whitelist, and npm
  **provenance** enabled, so a buyer verifies the package came from this repo.
  - **Writable data directory.** The engine no longer writes inside its own
    install (fatal once it lives under a read-only `node_modules`). A new
    `src/paths.js` resolves a per-user data directory — `CIVIC_DATA_DIR`, else the
    platform convention (`%APPDATA%`, `~/Library/Application Support`,
    `$XDG_DATA_HOME`/`~/.local/share`), all under `civic-chain-auditor`. The
    default SaaS, markets, Enron and LSEG databases and every audit log now live
    there; the shipped schemas and the municipal sample stay read-only in the
    package.
  - **First-run seed.** `cc-auditor ask`, and `cc-auditor mcp` with no warehouse
    configured, build the demo warehouse on first use (`ensureSeeded`), so a
    fresh install answers immediately.
  - **Bundled municipal demo.** The Town of Sampleton seed and allow-list ship in
    the package (`assets/municipal`, kept byte-identical to the skill copy by a
    drift test). `src/municipal.js` builds them into the data directory on demand.
  - **`cc-auditor doctor`.** A local-only setup check (no network, no subprocess,
    no credential read): verifies Node 22+/`node:sqlite`, a writable data dir,
    builds the municipal demo, loads it through the engine as a smoke test, and
    prints a ready-to-paste `npx`-based MCP client config pointing at the stable
    data-dir copies. Replaces the checkout-oriented `skills/.../verify-setup.js`
    for the npm path. New `test/paths.test.js` and `test/doctor.test.js` cover it.

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

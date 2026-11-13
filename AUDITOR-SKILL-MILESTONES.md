# Auditor Skill: Milestones & Engineering Handoff

**Branch:** `feat/grant-auditor-skill` (not merged; no PR yet)
**Owner after handoff:** _(engineer's name)_
**Milestone series:** `S` (skill track). The engine's `M0–M9` series in `HANDOFF.md` is separate and unchanged.

## Goal

Ship a **free** agent skill (listed on Agensi, usable in Claude Code, Cursor, Claude Desktop and other MCP hosts) that audits grant, budget and spending data. Four requirements:

1. **Every figure is verifiable.** Each one comes from a guarded, read-only query, carries a result hash, and is recorded in a hash-chained audit log.
2. **No API key and few tokens.** The user's own agent does the reasoning; the server does only deterministic work (queries, checks, hashing).
3. **Private data stays private.** Rules travel to the data; the data never travels to the server.
4. **Zero-friction start.** Paste one config line (or a URL) and ask a question.

---

## Status snapshot

| | |
|---|---|
| **Done (on branch)** | S0 custom warehouses · S1 skill package · S2 named queries + automatic checks · **S3 verified + security fix** · **S5 slim skill + Agensi package** |
| **Verified here (2026-11-13, Node 22)** | Full `npm test` **217/217 green**, including the 13 guard-dependent `custom-pipeline` tests (`node-sql-parser`) that had never run. The three `node-sql-parser` worries in old S3 (placeholder `(? IS NULL OR col = ?)`, qualified aliases in correlated subqueries, `COUNT(e.col)`) all pass. S3 security fix landed with 2 tests; S5 drift test (5 cases) green; the Agensi zip builds text-only, single top-level folder. |
| **Human-only, still open** | S5 asks to test the skill in two agents and have someone who didn't build it try it. Also S3 step 4's live in-Claude-Code click-through (its substance is covered by `custom-pipeline` tests 10–13). |
| **Not started** | S4 · S6–S11 (note: S4/S6/S7 still pending; S5 shipped ahead of S4 by request) |

> **Uncommitted as of 2026-11-13.** All S3 + S5 changes are in the working tree of `feat/grant-auditor-skill`, not yet committed. Contact placeholder resolved to `info@civic-chain.com` (open decision #4).

Commits on the branch, oldest first:

1. `Add custom warehouses configured from the environment`
2. `Add the vanguard-mcp-auditor agent skill`
3. `Add named queries with automatic checks for custom warehouses`

---

## Getting started

Environment quirks are in `HANDOFF.md` → "Environment quirks". Most important: **Node 22 is required** (`node:sqlite`).

```bash
git fetch origin && git checkout feat/grant-auditor-skill
cd vanguard-core
nvm use 22 && npm install
npm test        # expect ~209 test cases: 165 on main + 44 new (HANDOFF.md's "125" is stale)

# Build the demo ledger, validate it, smoke-test the engine, print MCP client config:
node ../skills/vanguard-mcp-auditor/scripts/verify-setup.js --core .
```

To try it in an agent, paste the printed `mcpServers` block into `.mcp.json` (Claude Code) and ask:
*"Run municipal/grant-status and tell me what the checks found."*

---

## Architecture (as of S2)

```
user's agent ── MCP (stdio) ──▶ vanguard-core
                                  │
            ┌─────────────────────┼──────────────────────────────┐
            ▼                     ▼                              ▼
   run_canonical            execute_financial_query        verify_audit / run_control
   (named queries,          (server-side model writes      (hash chain, SOC 2 controls)
    no credential)           SQL; needs API key)
            │                     │
            └──────────┬──────────┘
                       ▼
     guard.js (one SELECT; table AND column allow-list; LIMIT injected)
                       ▼
     read-only SQLite ──▶ rows ──▶ checks (named queries) / grounding (free text)
                       ▼
     lineage (result hash) ──▶ audit.js (hash-chained JSONL; optional Ed25519)
```

### Files added or changed on this branch

| File | What it is |
|---|---|
| `vanguard-core/src/custom.js` | Loads a custom warehouse from `VANGUARD_DB_PATH` + `VANGUARD_ALLOWLIST_PATH` (+ optional `VANGUARD_AUDIT_LOG`). Validates the allow-list against the live DB and compiles every named query at load. Needs only `node:sqlite`. |
| `vanguard-core/src/named-queries.js` | Pure logic: definition parsing, `:named` → `?` placeholder compiling (string/comment-aware), argument validation, check evaluation. No I/O. |
| `vanguard-core/src/named-run.js` | Runs a named query and its checks through the guard (passed in), the warehouse, lineage and audit. Also `validateNamedQueries` for startup. |
| `vanguard-core/src/planner.js` | `buildSystemPrompt(schema)`. The SaaS prompt is byte-identical to before. |
| `vanguard-core/src/ask.js` | Passes `allowedTables` / `allowedColumns` / `planSchema` through. |
| `vanguard-core/src/mcp.js` | Routes free text to any `freeText` warehouse. `run_canonical` accepts `<warehouse>/<query>`. `verify_audit` accepts `warehouse`. `vanguard://warehouses` lists named queries. |
| `vanguard-core/bin/vanguard.js` | `mcp` exits at startup if the custom warehouse config is bad or a named query is refused by the guard. |
| `vanguard-core/test/{custom,named-queries,custom-pipeline}.test.js`, `municipal-fixture.js` | Tests. The fixture builds the demo DB from the skill's shipped SQL, so breaking the skill's assets fails the core suite. |
| `skills/vanguard-mcp-auditor/` | The skill: `SKILL.md`, `README.md` (marketplace copy), `assets/` (fictional "Town of Sampleton" seed SQL, 108 rows; allow-list with 3 named queries), `scripts/verify-setup.js` (local-only setup check). |

### Concepts the engineer needs

- **Allow-list file** (`assets/sample_allowlist.json`): `name`, `description`, `domain`, `tables` (table → permitted columns), `notes` (planner hints), `queries` (named queries).
- **Named query:** operator-written SQL with `:named` parameters. Omitted optional parameters bind as NULL, so filters are written `(:p IS NULL OR col = :p)`. Values are always bound as parameters, never spliced into the SQL.
- **Check severities:**
  - `integrity` (`unique`, `total_matches`): a flag means the result may be wrong. Never present it as fact.
  - `finding` (`compare`): a flag is an audit finding about the data, e.g. an overspent budget line.
- **Demo findings, by design:**
  - G-402: cash drawn ahead of spending, plus a voided duplicate invoice.
  - G-317: unreimbursed costs.
  - BL-26-02: winter salt overspent.
  - G-366: closed with part of the award unspent.
  - `payroll` and the vendor tax-ID/bank columns are withheld, so you can watch the guard refuse them.

---

## Completed milestones

| ID | Milestone | Status |
|---|---|---|
| S0 | Custom warehouse from environment (loader, planner schema, MCP routing, fail-fast startup) | ✅ |
| S1 | Skill package: SKILL.md, marketplace README, demo ledger, allow-list, `verify-setup.js`; text-only zip (the `.sqlite` is built locally and gitignored) | ✅ |
| S2 | Named queries + automatic checks (`unique`, `total_matches`, `compare`); checks recorded in audit entries; 3 demo queries | ✅ |
| S3 | Full suite verified with the real guard (217/217); `run_canonical` **and** `run_control` arg-injection fixed (caller args whitelisted per query; infra `dbPath`/`logPath` moved to trusted `ctx.overrides`, unreachable from the MCP wire) + 2 tests. `verify_audit` logPath left open per plan, to be disabled in S7. | ✅ |
| S5 | SKILL.md slimmed 250→95 lines; setup/refusals/controls moved to `references/*.md`; 3 `examples/` transcripts with real figures + hashes; drift test (`test/skill-drift.test.js`, 5 cases) reconciles documented tools/controls/queries/reasons against code; `scripts/package.sh` (single top-level folder, text-only, binary guard); contact filled. **Human-only remainder:** two-agent + fresh-eyes testing. | ✅ |

---

## Remaining milestones (in priority order)

Sizes are rough: **S** ≤ 1 day · **M** 2–4 days · **L** 1–2 weeks.

### S3 · Verify the branch and close security gaps (blocker) · S

**Why:** nothing ships until the full suite passes with the real guard.

**Do:**
1. Run `npm test`. If anything fails, these are the likely culprits; I couldn't confirm how `node-sql-parser` handles them:
   - the `(? IS NULL OR col = ?)` placeholder pattern in the demo queries
   - qualified aliases inside correlated subqueries (`e.amount_cents` within `SELECT … FROM grants g`)
   - whether `COUNT(*)` would trip `wildcard_not_allowed` (the demo avoids it by using `COUNT(e.expenditure_id)`; confirm and document)
2. **Security fix, pre-existing on `main`:** `run_canonical` spreads caller `args` into the built-in canonical functions (`fn({ ...(args.args ?? {}), signer })`). An MCP caller can therefore pass `dbPath`, `logPath` or `warehouse` and redirect the query or the audit log. Whitelist arguments per canonical query (named queries already reject unknown parameters).
3. `verify_audit` accepts any `logPath` from the caller. That's fine locally, but it must be disabled before S7 (hosted).
4. Run it in Claude Code against the demo and check that SKILL.md's routing works: the named query is tried first, an integrity flag is not presented as fact, and findings are reported.

**Done when:** `npm test` is green, the security fix has a test, and a manual Claude Code session behaves as described.

### S4 · Key-free free-text path: `run_query` + `verify_answer` · M

**Why:** `execute_financial_query` runs a second model on the server, which needs an API key and costs tokens. The user's agent can write the SQL itself.

**Do:**
- `run_query { warehouse, sql }`: the agent's SQL → guard (same allow-lists) → read-only execute → `{ rows, lineage, provenance }`, appended to the warehouse log.
- `verify_answer { warehouse, auditSeq, text }`: reads the log entry, **re-runs its SQL and confirms the result hash still matches** (stateless; nothing cached), then runs `grounding.js` on `text` against those rows. Returns verified figures and ungrounded figures. The skill tells the agent to fix ungrounded figures and call again before replying (max 2 rounds, mirroring `narrator.js`).
- Optional **required-filter rules** in the allow-list, e.g. "any query summing `expenditures.amount_cents` must filter `status`". Enforce as a guard-level warning or refusal.
- Keep `execute_financial_query` for hosts that want the full server-side pipeline.

**Done when:** the demo free-text questions work with no API key, and an answer containing an invented figure is caught by `verify_answer` (test).

### S5 · Slim the skill and finish the Agensi package · S

**Why:** SKILL.md (~250 lines) loads into the agent's context on every use. Agensi also expects examples and rejects binaries.

**Do:**
- Cut SKILL.md to a ~100-line core: routing, presentation, the integrity/findings rules. Move the refusal table, controls list and setup into `references/*.md`, loaded on demand.
- Add `examples/`: three transcripts with real demo figures and hashes (a grant-status finding, a refused tax-ID request, an audit-chain verification).
- A **drift test** that fails if SKILL.md names a tool, control id, canonical query or refusal reason that the code doesn't have.
- `scripts/package.sh`: zip with a single top-level folder, text only, excluding `.sqlite`, `.DS_Store` and `Thumbs.db`.
- Fill the `[CONTACT_EMAIL_OR_URL]` placeholder (SKILL.md and README.md).
- Agensi requirements (see their creator checklist): the description starts "Use when the user asks to…" (done); test in two agents; get someone who didn't build it to test it.

**Done when:** the zip passes a local re-check of Agensi's 8 scan categories (file structure, file types, dangerous commands, secrets, env-var harvesting, network access, obfuscation, prompt injection).

### S6 · Rename + `npx` package · M

**Why:** "Vanguard" collides with The Vanguard Group in search, and may be a trademark problem for a finance product (**get legal advice before choosing a name**). Also, `npx` removes the clone/install step.

**Do:**
- Choose the name; check the npm package, domain and Agensi slug are available.
- Publish `vanguard-core` under the new name: remove `"private": true`, add a `bin`, a `files` whitelist, and include the seed SQL.
- On first run, build the demo DB into a user data directory (the npx cache may be read-only).
- Rename the skill folder, `name:` frontmatter and README. The GitHub repo rename can wait.

**Done when:** a client config of only `{ "command": "npx", "args": ["-y", "<name>", "mcp"] }` serves the demo.

### S7 · Hosted public demo (remote MCP over HTTP) · M

**Why:** gives Agensi users a no-download first run.

**Do:**
- Add a Streamable HTTP MCP transport (the MCP SDK already in the project includes one). The existing `http-server.js` is a JSON API for M7, not MCP.
- Deploy with **demo data only**. Coordinate with the M7 deploy work in `HANDOFF.md` and `supabase/README.md`, and reuse that infrastructure if it lands first.
- Expose only key-free tools: named queries, `run_query` / `verify_answer` (S4), controls, `verify_audit` by warehouse name. **No `execute_financial_query`, no `logPath` parameters.**
- Rate limiting; a shared public audit log on persistent storage, with a published reset policy.
- Cache the custom warehouse descriptor: `warehouseDescriptors()` currently reloads and recompiles it on every call.

**Done when:** adding the URL in Claude/Cursor lets a new user run all demo prompts with zero install.

### S8 · Bring your own data: `import_csv` · M

**Why:** real users have a CSV export, not a SQLite file.

**Do:**
- `import_csv { path, table }` on the **local** engine only. Never on the hosted one; files are read by path, not pasted into chat.
  - Typed columns.
  - Money parsing (`$1,234.56` → `123456` cents).
  - Date normalization.
  - Record the file's SHA-256 as an audit entry.
- Column mapping onto the canonical schema (S9): the agent proposes a mapping, the user confirms, and the mapping is saved and recorded in the log.
- Generate a draft allow-list for review.

**Done when:** a real public municipal expenditure CSV (any city open-data portal) imports, maps, and runs `grant-status` / `budget-variance` with clean integrity checks.

### S9 · Rulesets: audit logic separate from access policy · L

**Why:** today the named queries live in the allow-list. Separate them:
- the **allow-list** = what may be read (the data owner's policy)
- the **ruleset** = what to compute and check (the auditor's logic)

That lets third parties publish rulesets.

**Do:**
- Define **Canonical Municipal Schema v1** (grants, budget lines, expenditures, drawdowns, vendors), seeded from the demo schema.
- Ruleset format: schema version + named queries + checks + metadata. It is content-addressed by SHA-256 of a canonical JSON serialization (reuse `lineage.canonicalize`).
- Every audit entry records `rulesetHash` and `dataHash`.
- The engine fetches rulesets from a registry by `name@version`, **verifies the hash**, and runs them locally.

**Done when:** the same CSV + the same ruleset version on two machines produce identical result hashes (test).

### S10 · Notarization (prove an audit existed, without disclosure) · S–M

**Do:**
- A hosted endpoint accepts only `{ chainHeadHash, rulesetHash, timestamp }` and returns a receipt signed with the server's Ed25519 key (reuse `signing.js`). It never receives rows.
- A CLI to verify a receipt offline.
- RFC 3161 timestamping and WORM storage are enterprise follow-ups.

**Done when:** a receipt verifies offline, and changing any byte of the log breaks it.

### S11 · On-demand second-session auditor (optional) · S

**Why:** checks catch wrong arithmetic and double counting, not a query that answers the wrong question. This is for the rare high-stakes answer, at the cost of extra tokens.

**Do:**
- In SKILL.md (or a `references/` file): on request, start a subagent with only the question, schema and draft. It writes its own SQL, runs it, and compares figures.
- `record_review { warehouse, seqs, verdict, notes }` links both entries in the log.
- Where subagents aren't available, fall back to a labelled self-review.
- Never call this an "independent audit".

---

## Data flow & privacy model (target state after S8–S10)

1. **Import (local):** CSV → `import_csv` → SQLite; file SHA-256 logged.
2. **Map:** columns → canonical schema (agent proposes, user confirms).
3. **Fetch ruleset:** `name@version` from the registry, hash verified.
4. **Run (local):** named queries + checks. Each entry records `dataHash`, `rulesetHash` and `resultHash`.
5. **Report:** the agent builds a document from the result JSON, with figures copied verbatim and hashes shown.
6. **Notarize (optional):** only hashes go to the server; a signed receipt comes back.

| Party | Sees |
|---|---|
| Hosted server | Ruleset downloads; hashes if notarizing. **Never rows.** |
| AI model (user's agent) | Only the query results it reads (mostly totals), plus anything the user pastes into chat |
| Third-party reviewer | Report + hashes. With the CSV, they can re-run the same ruleset version and match the result hashes. |

**Tiers:**
- **Public data** (most municipal budgets are public records): the hosted demo or an upload, with a delete-after-session policy.
- **Private data:** the local engine (`npx`), with the server used only for rulesets and notarization.

---

## Open decisions (for the product owner)

1. **New name:** trademark check first.
2. **Hosting provider for S7/S10:** reuse the M7 Supabase/edge stack or a small container host?
3. **Ruleset authorship:** first-party only at launch, or open to third parties (needs review and signing)?
4. **Enterprise contact** for the SKILL.md/README callout.
5. **Ship order:** S3 → S4 → S5 is the minimum for a credible free Agensi listing. Can S6/S7 follow, or must they launch together?

## Known caveats

- The free-text SaaS answers log to `db/audit.jsonl`, but the `saas` warehouse descriptor's log is `db/saas-audit.jsonl`. `verify_audit {warehouse:"saas"}` therefore checks the canonical/control log, not the free-text one (documented in SKILL.md). Consider unifying.
- `verify_audit` over MCP checks the hash chain only, not signatures; the CLI checks both.
- Every bundled dataset is synthetic. Reports must say so, and SKILL.md instructs agents to.

# Civic-Chain Auditor: Commercial Milestones (proposal)

**Status:** proposal, not committed. Supersedes the "free listing" goal in `AUDITOR-SKILL-MILESTONES.md`.
**Base branch:** `feat/auditor-skill-s3-s5` (S0–S3 and S5 done; `npm test` reported 220/220 green on 2026-11-13).
**Date:** 2026-11-14

## The three decisions this plan implements

1. **Licence.** MIT is dropped going forward. New versions of the engine and skill ship under a Civic-Chain commercial licence.
2. **Model.** Source-available engine, paid right to use. A monthly Agensi subscription pays for upkeep and new rulesets. There is no technical enforcement; a buyer who captures the engine and rules can keep running that copy.
3. **Why buy.** It comes from a real, named vendor: civic-chain.com.

## Constraints that shape everything below

- **No Civic-Chain infrastructure in the product.** The engine runs on the buyer's machine against the buyer's files. This plan adds **no** servers, endpoints, licence checks or telemetry. The only Civic-Chain assets involved are the website (static pages) and one offline signing key.
- **Buyer data never leaves the buyer's machine**, except to their own AI provider through their own agent.
- **Wording.** With a paid licence the engine is "source-available", not "open source". Using "open source" for it invites complaints.

## What is already done

| ID | Milestone | State |
|---|---|---|
| S0 | Custom warehouse from environment | ✅ |
| S1 | Skill package, demo ledger, setup script | ✅ |
| S2 | Named queries with automatic checks | ✅ |
| S3 | Full suite verified; caller arguments whitelisted; path arguments removed; read-only opens | ✅ |
| S5 | Slim SKILL.md, references, examples, drift test, text-only packaging | ✅ |

---

## Phase 1 · Make it legally and commercially yours (blocks listing)

### C1 · Relicense · S · needs a lawyer
- Have counsel draft a **Civic-Chain Commercial Licence**: right to use while subscribed, source visible for inspection, no redistribution or resale, no warranty, limitation of liability, statement that outputs are not a professional audit opinion.
- Add `LICENSE` at the repo root and in the package. Set `"license": "SEE LICENSE IN LICENSE"` in `package.json`.
- Remove the MIT badge and "MIT." section from the root `README.md`; replace "MIT, same as Vanguard MCP" in the skill README; replace "open-source engine" in `references/controls.md`.
- Add a copyright header convention for new files.
- **Record the cut-over commit.** Versions published before it were offered as MIT and stay MIT for anyone who already has them. Counsel should confirm (a) you own all prior code outright and (b) how to word the change notice.
- Decide repo visibility. Recommended: **keep it public** (source-available is part of the trust story) under the new licence. Going private is possible but removes the "inspect it yourself" selling point.

**Done when:** no file in the default branch claims MIT or open source, and `LICENSE` is counsel-approved.

### C2 · Rebrand to Civic-Chain · S–M
- Product name, e.g. **Civic-Chain Grant & Budget Auditor**. This also retires the "Vanguard" name collision. Do a trademark check on the final name.
- Rename the skill folder, frontmatter `name:`, MCP server key, CLI name and env-var prefix (`VANGUARD_*` → new prefix, keeping the old names as aliases for one release).
- Update the drift test and `package.sh` for the new names.

**Done when:** a fresh install shows no "Vanguard" in anything a buyer sees.

### C3 · Merge and release hygiene · S
- Open the PR for `feat/auditor-skill-s3-s5`, merge to `main`. Today `main` lacks the engine code the skill needs, so setup fails for anyone cloning it.
- Tag `v1.0.0`. Adopt semantic versions and a `CHANGELOG.md` (subscribers are paying for the changes; show them).
- Set `ENGINE_SERVICE_TOKEN` as **required** for `vanguard serve` (currently optional, so the HTTP API can run unauthenticated). Not part of the skill, but it is in the same package.
- Remove `package.sh` from the shipped zip.

---

## Phase 2 · Make it work on the buyer's own data (the reason to pay)

### S6 · One-line install · M
- Publish the engine to npm under the Civic-Chain name with the commercial licence, a `bin`, and a `files` whitelist. Enable npm provenance so buyers can verify the package came from your repo.
- Client config becomes one `npx` line. First run builds the demo ledger into a user data directory.
- The setup check becomes a subcommand (`<cli> doctor`) so nothing has to be saved from the Agensi listing.

**Done when:** a new user goes from zero to a demo answer with one pasted config block.

### S8 · Import the buyer's CSV · M
- `import_csv` (local only): typed columns, money to integer cents, date normalisation, SHA-256 of the source file recorded as an audit entry.
- Column mapping onto the canonical schema: the agent proposes, the user confirms, the mapping is saved and logged.
- Never accepts pasted data; files are read by path from a folder the user names at startup.

**Done when:** a real public municipal expenditure CSV imports and runs the three existing queries with clean integrity checks.

### S9 · Rulesets as the product · L
- Separate **access policy** (allow-list, the buyer's) from **rulesets** (queries + checks, Civic-Chain's).
- Canonical Municipal Schema v1.
- Ruleset format with name, version, changelog, and a content hash. Every audit entry records `rulesetHash` and `dataHash`.
- **Rulesets ship inside the npm package.** No registry server. A subscription update is a new package version.
- **Sign each ruleset** with a Civic-Chain Ed25519 key (reuse `signing.js`). The engine verifies the signature and reports "Civic-Chain signed" or "unsigned / modified" in every result. The private key lives offline, never on a server or in CI.

**Done when:** the same CSV and ruleset version on two machines give identical result hashes, and editing one byte of a ruleset flips it to "modified".

### S4 · Key-free open-ended questions · M
- `run_query` (the agent's SQL through the guard) and `verify_answer` (figure check against re-run rows).
- Removes the need for the buyer's Anthropic API key for anything outside the rulesets.

### R1 · Audit report · M
- A report generator: findings, figures, the ruleset name/version/signature status, data hash, result hashes, and the audit-chain status. Output as Markdown and PDF-ready HTML.
- Fixed disclaimer: produced by software, not a CPA opinion; synthetic-data notice when the demo ledger is used.

**Done when:** a buyer can hand the report to a finance director or grantor without editing it.

---

## Phase 3 · The vendor trust story (civic-chain.com)

### V1 · Product presence · S–M
- Product page on civic-chain.com: what it does, who is behind it, how to buy, how to get support.
- **Security & privacy statement:** runs locally, no telemetry, no Civic-Chain servers involved, what the buyer's agent sends to their AI provider. Publish the ruleset signing **public** key and its fingerprint here.
- `SECURITY.md` with a disclosure address; a support address and response-time commitment.
- Static pages only. Do not add forms or APIs that touch internal systems.

### V2 · First real ruleset pack · L · needs a subject expert
- A grants-compliance pack beyond the demo three. Candidate basis: federal grant rules (2 CFR 200, Uniform Guidance) for allowable-cost timing, period of performance, drawdown-versus-expenditure, match tracking, vendor concentration, duplicate invoices.
- Each rule cites the requirement it checks and is reviewed by someone with grants-audit experience (a named reviewer strengthens the listing).
- Do not claim certification or endorsement by any agency.

### V3 · Subscription cadence · ongoing
- Publish a ruleset roadmap and ship on a schedule (e.g. monthly). The changelog is what subscribers see for their money.
- Version support policy: which engine versions each ruleset supports.

---

## Phase 4 · List and sell on Agensi

### A1 · Subscription listing · S–M
- **Confirm with Agensi first:** their creator guide says paid skills are served through the agent connection and buyers may not save, copy or export any part. This plan therefore keeps the Agensi item to **SKILL.md and reference text only**; the engine and rulesets come from npm. Ask Agensi whether a subscription skill may instruct the agent to install an npm package, and whether that fits their terms.
- Payout setup (Stripe Connect or Zoneless). Creators keep 70% per their guide.
- Price: open decision. Their guide's ranges are for one-time purchases; a subscription should be justified by the release cadence in V3.
- Listing copy led by the vendor name, the privacy statement, and one example finding with real hashes.
- Tags, example session, and a free trial path (the demo ledger works without a subscription key because there is no key).

### A2 · Pre-launch verification · S
- Test in Claude Code and one other agent; have someone who did not build it run setup from the listing alone.
- Re-run the outbound-reference scan on the final zip (expected: the npm/GitHub link and civic-chain.com addresses only).
- Re-check against Agensi's 8 scan categories.

---

## Phase 5 · Later, only if needed

| ID | Item | Note |
|---|---|---|
| S10 | Notarization receipts | Requires a hosted endpoint. Build only on infrastructure fully separate from Civic-Chain systems. |
| S7 | Hosted demo | Same isolation requirement. Optional once `npx` install exists. |
| S11 | Second-session auditor | On-demand cross-check for high-stakes answers. |
| E1 | Enterprise adapters (Postgres, Snowflake, BigQuery), SSO | Sold directly, not through Agensi. |

---

## Suggested order

1. **C1, C3** (licence, merge): unblock everything.
2. **C2, S6** (brand, one-line install).
3. **S8, S9, R1** (their data, signed rulesets, a report): the paid value.
4. **V1, V2** (vendor presence, first real pack).
5. **A1, A2** (list as a subscription).
6. **S4**, then Phase 5 as demand shows.

A free listing with the demo could go live after step 2 to start collecting interest, switching to the subscription once step 4 is done.

## Open decisions

1. Final product name and trademark check.
2. Repo public (recommended) or private.
3. Subscription price, and whether to run a free tier (demo rulesets) beside the paid pack.
4. Who reviews the V2 ruleset pack.
5. Whether Agensi's paid-delivery terms allow the npm install path (A1); if not, sell the subscription from civic-chain.com and keep a free Agensi listing as the funnel.
6. Support commitment (hours, response time) you are willing to publish.

## Risks to keep in view

- **No enforcement.** Accepted by design. Revenue depends on the update cadence and the vendor's name, not on locks.
- **Liability.** Buyers may treat output as an audit. The licence, the report and the listing must all say it is not one.
- **Prior MIT copies.** Cannot be recalled. The upgrade (rulesets, import, reports, signing) is what the new licence covers.
- **Signing key.** If it leaks, anyone can ship "Civic-Chain signed" rules. Keep it offline, document rotation, publish the fingerprint.

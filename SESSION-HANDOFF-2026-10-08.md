# Vanguard MCP, Session Handoff (2026-10-08)

**Read this first on a fresh context.** Vanguard MCP is a **Civic-Chain** product: a verified-SQL
financial-attestation engine + MCP server, now positioned as a **municipal / public-finance**
verification tool ("public money, verified"). It was cloned and rebranded from the Fin-Telligence
prototype. **The original `fin-telligence` project is left entirely alone, do not touch it.**

## Where things are

- **Repo (live):** https://github.com/justin-harvey/Vanguard-MCP, `main`. Local: `/home/nah/Claudia/vanguard-mcp`.
- **Site (Civic-Chain branded):** `site/`, `index.html` (landing), `enron.html` (reporting-gap case
  study), `controls.html` (SOC 2 evidence panel), `assets/civic.css` (brand tokens), and the two
  logos (`civic-chain-logo.svg` = favicon, `civic-logo-w-text-horizontal.svg` = header wordmark).
  Co-brand lockup: **Civic-Chain** (umbrella) + **Vanguard MCP** (product). **Not yet deployed.**
- **Engine:** `vanguard-core/`, CLI `node bin/vanguard.js <sub>`, MCP scheme `vanguard://`, env
  `VANGUARD_*`. **165/165 tests green on Node 22** (`nvm use 22`; `node:sqlite` needs 22).

## Done this session
- Rebranded to the Civic-Chain system (cream/blue, DM Serif Text / DM Sans). Dropped the LSEG demo
  page and the Phineas mascot from the site; Enron is the lead case study.
- Full rename Fin-Telligence → Vanguard MCP across site + engine (dir `vanguard-core`, CLI
  `vanguard`, scheme `vanguard://`). Suite stayed 165/165 green.
- Created the repo and pushed.
- **Docs:** rewrote the main README for municipal focus; scrubbed LSEG from `README.md` and
  `vanguard-core/README.md`; deleted the three root `LSEG-*.md` docs. Kept Justin's web edits
  (plain-language premise + Live link) when reconciling.

## Open / handed to others (NOT this session's work)
- **Deploy the site (Netlify):** new site → base directory `site`, no build command (configs already
  in place). Netlify CLI not installed locally → UI step, or `npm i -g netlify-cli` + `netlify login`.
  The README's `Live:` link points at `vanguard-mcp.netlify.app/` and will 404 until this is done.
- **Engine LSEG deep-clean (Engineering):** LSEG still lives in code + code-adjacent docs,
  `vanguard-core/src/lseg*.js`, the LSEG tests, `db/lseg-*`, `mcp/`, and woven into `controls.js`
  (3 LSEG controls), `warehouses.js`, `registry.js`, `bin/vanguard.js`. Removing it is a code+test
  change (test count drops from 165). Also still referenced in historical `HANDOFF.md` and
  `SESSION-HANDOFF-2026-09-26/28.md` (engineering build logs, left as history).
- **Trademark sanity-check on "Vanguard"** (Vanguard Group is a large finance brand).

## NEXT SESSION: branding + Civic-Chain presence
Goal: deepen the Civic-Chain brand integration and the product's civic presence. Confirm priorities
with Justin, but candidate work:
- Tighten the site against the Civic-Chain brand system, surfaces, material textures
  (old-paper / banknote / blueprint), tone cards, spacing, beyond the current token pass.
- Wire Vanguard MCP into the broader Civic-Chain web presence (the civic-chain.com ecosystem):
  cross-links, shared nav/footer, and a decision on route vs subdomain (e.g. a `/vanguard` route on
  the main site vs a standalone `vanguard-mcp.*`).
- Municipal-facing landing copy and a worked municipal example (budget / grant-drawdown
  reconciliation framing), honest; do not imply a municipal warehouse exists unless one is built.
- Deploy to Netlify so there is a live URL to point at, then a GEO/SEO pass (see the `geo` skills).

## References & gotchas
- **Brand source of truth:** https://civicchain-v2.vercel.app/brand (tokens/logos/surfaces).
  Design project tokens: the claude.ai/design "Civic-Chain design system" project.
- **`main` receives out-of-band GitHub web-UI edits** (happened this session), always
  `git fetch` + rebase before pushing, or the push is rejected non-fast-forward.
- **Pushes:** PAT pasted inline per push, used inline, never persisted (origin stays token-less).
- Repo-local git identity: justin-harvey / jharvmail@gmail.com.

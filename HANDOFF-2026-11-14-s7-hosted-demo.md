# Handoff — S7 Hosted Demo (next session)

**Date written:** 2026-11-14
**Repo:** `/home/nah/Claudia/vanguard-mcp` · remote `justin-harvey/Vanguard-MCP`
**Branch:** `main` at `b95c196`, tag `v1.0.0` (pushed). Node 22 required (`nvm use 22`); engine uses `node:sqlite`.
**Plan of record:** `AUDITOR-COMMERCIAL-MILESTONES.md` (S7 is in Phase 5).

---

## Update — 2026-11-14 (code built this session)

Decisions locked with Justin: **engine host = Fly.io** (the engine is Node +
`node:sqlite`, so it cannot run on Supabase itself — only the proxy can);
**warehouse = municipal only** for the exposed surface; **live, canonical tools
only** (anon = `standard`, no Anthropic key); **proxy stays on Supabase**.

**Built and verified locally (engine path + full `{tool,args}` proxy contract):**
- `Dockerfile`, `.dockerignore`, `fly.toml` (repo root) — Fly image runs
  `cc-auditor serve`, bakes the synthetic warehouses at build time, audit chain on
  a `/data` volume, `ENGINE_SERVICE_TOKEN` as a secret.
- `supabase/functions/query/index.ts` — rebranded; `sanitize()` rewritten for the
  municipal named queries; `verify_audit`/free-text default to `municipal`.
- `site/demo.html` + `site/assets/demo.js` — live municipal query builder with
  checks/findings/provenance + verify-chain; synthetic/disclaimer banners; linked
  from `index.html` and `/demo` (`_redirects`). Sample fallback when no proxy set.
- Rebranded all `site/*.html` + `netlify.toml` off "Vanguard".
- `deploy/README.md` — full runbook. `CHANGELOG.md` — `[Unreleased]` section.

**Not run here (needs Justin's isolated accounts — these are the remaining steps):**
1. `fly launch`/`fly secrets set ENGINE_SERVICE_TOKEN`/`fly volumes create`/`fly deploy`
   in a Fly org separate from Civic-Chain prod; confirm `GET /health`.
2. `supabase secrets set MCP_ENGINE_URL/ENGINE_SERVICE_TOKEN/ALLOWED_ORIGIN` +
   `supabase functions deploy query` in an isolated Supabase project.
3. Set `window.CIVIC_PROXY_URL` (in `site/demo.html` or a Netlify snippet) to the
   deployed function URL; redeploy Netlify; run the network-tab isolation check.

The Deno proxy file was **not executed here** (no Deno/supabase CLI in this env);
its `sanitize` logic was validated via an equivalent Node shim in front of the
real engine. Smoke it with `supabase functions serve query` before trusting prod.

Everything below is the original pre-build plan, kept for context.

---

## Where we are (done)

C1/C2/C3 shipped on `main` and tagged `v1.0.0`:
- **C1 relicence:** counsel-pending `LICENSE` (Civic-Chain Commercial, source-available) at repo root and in `vanguard-core/`; `package.json` `license: SEE LICENSE IN LICENSE`; MIT/"open source" claims about the engine removed; `COPYRIGHT.md` header convention.
- **C2 rebrand → Civic-Chain Grant & Budget Auditor:** CLI display name `cc-auditor`; MCP server name `civic-chain-auditor`; resource scheme `civic-chain://`; host config key `civic-chain-auditor`; env vars `CIVIC_*` with `VANGUARD_*` as a one-release fallback; skill folder `skills/civic-chain-auditor/`.
- **C3 hygiene:** `cc-auditor serve` **refuses to start without `ENGINE_SERVICE_TOKEN`**; `CHANGELOG.md`; `v1.0.0`; `scripts/package.sh` excluded from the shipped zip.
- Tests: **220/220 green under Node 22.**

---

## What S7 is

> Phase 5, S7 — **Hosted demo.** "Same isolation requirement. Optional once `npx` install exists."

A public, click-through demo of the Auditor running on a server, so a prospect can try it without installing anything. Distinct from the skill (which runs on the buyer's own machine).

### Hard constraint (from the plan, non-negotiable)
**Isolation.** S7 and S10 must be built **only on infrastructure fully separate from Civic-Chain production systems.** The product's whole trust story is "no Civic-Chain infrastructure touches buyer data." The hosted demo must serve **synthetic data only** and live in its own isolated project/account so it can never be confused with, or reach, anything real. Label synthetic data as synthetic on every screen.

---

## What already exists (build on this, do not rebuild)

The M7 web-proxy architecture is already scaffolded for exactly this:

1. **Engine HTTP API** — `vanguard-core/src/http-server.js`
   - `cc-auditor serve [--port N]` (`bin/vanguard.js`, `serve` case). Routes: `GET /health`, `GET /tools`, `POST /tools/:name`, `GET /resources`.
   - Auth: bearer `ENGINE_SERVICE_TOKEN` (now **required** by the CLI). CORS via `ENGINE_CORS_ORIGIN`.

2. **Secure proxy** — `supabase/functions/query/index.ts` (Deno edge function, "M7 secure proxy")
   - Browser → this function → engine. Engine URL + token live only here (`MCP_ENGINE_URL`, `ENGINE_SERVICE_TOKEN`, `ALLOWED_ORIGIN`).
   - Role gating: `standard` (list_controls, run_control, run_canonical, verify_audit) vs `auditor` (+ execute_financial_query). Anon = standard.
   - `sanitize()` strips client args so a caller can't redirect db/log paths.
   - Deploy: `supabase functions deploy query`; set the three secrets.

3. **Static front-end** — `site/` (Netlify; `netlify.toml` publishes `site/`, no build step)
   - `index.html`, `enron.html`, `controls.html`, `value.html`, assets, `_redirects`.
   - Live demo already at https://vanguard-mcp.netlify.app/ (static pages).

So S7 is mostly **wiring + isolation + rebrand**, not new engine code.

---

## Gaps to close for S7

1. **Stand up the engine on an isolated host.** Container (Node 22) running `cc-auditor serve` with a seeded demo warehouse and a strong `ENGINE_SERVICE_TOKEN`. Candidates: Fly.io / Render / a small VM — in a **separate account from any Civic-Chain prod**. Must not be the same project as any real system. (Open decision: which host — see below.)
   - Seed on boot: `node bin/vanguard.js seed` (SaaS) and/or the municipal demo via `CIVIC_DB_PATH`/`CIVIC_ALLOWLIST_PATH` pointing at `skills/civic-chain-auditor/assets/`.

2. **Expose the right demo warehouse.** The proxy's `sanitize()` currently hardwires `execute_financial_query` to `warehouse: "saas"` and only forwards `ticker` for `run_canonical`. For a *Grant & Budget* demo you likely want the **municipal** warehouse and its named queries (`municipal/grant-status`, `municipal/spending-by-vendor`, `municipal/budget-variance`) surfaced instead. Decide SaaS vs municipal (recommend municipal — it's the product) and update `sanitize()` + role tools accordingly.

3. **Deploy the proxy** in an isolated Supabase project; set `MCP_ENGINE_URL` (the host from step 1), `ENGINE_SERVICE_TOKEN` (matching step 1), `ALLOWED_ORIGIN` (the Netlify site).

4. **Wire the front-end to the proxy.** The `site/` pages are currently static; add the client calls to the edge-function URL so the demo actually runs queries live (or confirm whether a live path is wanted vs a canned walkthrough — open decision).

5. **Rebrand the hosted surface (carries C2 into the web layer).** These were out of the C2 skill scope and still say "Vanguard":
   - `netlify.toml` header comment ("Vanguard MCP, a Civic-Chain product").
   - `supabase/functions/query/index.ts` header ("Vanguard MCP, the M7 secure proxy").
   - `site/*.html` copy and `<title>`s (grep `site/` for "Vanguard").
   - Consider the Netlify site name/URL (`vanguard-mcp.netlify.app`) — rename to a civic-chain URL once the GitHub repo rename happens (see below).

6. **Synthetic-data notices + "not a professional audit opinion"** on every demo page (mirror the LICENSE §7 language and the skill's synthetic-data notice).

---

## Suggested step order

1. Decide host + warehouse (open decisions below).
2. Rebrand `site/`, `netlify.toml`, the proxy header (quick, unblocks a clean public face).
3. Containerise the engine (Dockerfile: Node 22, `npm ci`, seed, `serve`), deploy to the isolated host, confirm `GET /health` returns `{ ok, name: "civic-chain-auditor", version: "1.0.0" }`.
4. Update proxy `sanitize()`/roles for the chosen warehouse; deploy edge function with secrets.
5. Wire front-end → proxy; add synthetic/disclaimer banners.
6. End-to-end test from the public URL as an anon ("standard") user; confirm the engine token never reaches the browser (check network tab).

---

## Open decisions (ask Justin)

1. **Host for the engine** — Fly.io / Render / VM? Must be an account isolated from Civic-Chain prod.
2. **Which warehouse** the hosted demo exposes — municipal (recommended, it's the product) or keep SaaS/enron.
3. **Live queries vs canned walkthrough** — does the public demo actually hit the engine, or is it a scripted tour with pre-baked results?
4. **Public URL / Netlify site name** — keep `vanguard-mcp.netlify.app` for now or move to a civic-chain subdomain (ties to the repo rename).
5. Whether to gate the `auditor` (free-text, needs an Anthropic key) tier behind a sign-in, or keep the public demo to the no-credential canonical/control tools only (recommended for cost + safety).

---

## Watch out for

- **Don't ship the engine token to the browser.** It lives only in the host env and the edge-function secrets. The browser only ever talks to the edge function.
- **`serve` now exits 1 without `ENGINE_SERVICE_TOKEN`** — the container MUST set it or the engine won't start (this is intended).
- **Isolation is the point.** If the only available host is shared with real Civic-Chain systems, stop and raise it rather than co-locating.
- **ANTHROPIC_API_KEY** is only needed if the demo exposes `execute_financial_query` (free text). Canonical queries, controls, and audit verification need no credential — cheapest/safest public tier.

---

## Still-open from earlier phases (not S7, but adjacent)

- **Counsel sign-off** on `LICENSE` (still a draft) + confirm prior-code ownership and change-notice wording (C1 open item).
- **Rename the GitHub repo** `Vanguard-MCP → Civic-Chain-Auditor` (redirects old URLs); clears the last buyer-visible "Vanguard" (the clone URL in the skill README).
- Next *build-value* milestone per the plan's order is actually **S6 (one-line npx install)**, then **S8/S9/R1**. S7 is being pulled forward by choice to collect interest — fine, but S6 unblocks the "install" story the plan leans on.

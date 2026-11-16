# Handoff — S7 hosted demo, code pushed (next session)

**Date written:** 2026-11-15
**Repo:** `/home/nah/Claudia/vanguard-mcp` · remote `justin-harvey/Vanguard-MCP`
**Branch:** `main` at `66676d3` (pushed). Previous tag `v1.0.0` at `b95c196`.
**Node:** 22 required (`nvm use 22`); engine uses `node:sqlite`.
**Plan of record:** `AUDITOR-COMMERCIAL-MILESTONES.md` (S7 is Phase 5).

---

## State: S7 is built and pushed, NOT yet deployed

All the S7 **code** for the hosted demo is on `main` (commit `66676d3`). What is
left is the **deploy**, which needs Justin's own isolated cloud accounts and so
was not run here. See "Remaining steps" below.

### Decisions locked (2026-11-14, with Justin)
- **Engine host = Fly.io.** The engine is Node + `node:sqlite`, so it cannot run
  on Supabase (Deno, no `node:sqlite`, no persistent FS). Only the proxy runs on
  Supabase.
- **Warehouse = municipal only** for the exposed surface (the Agensi grant-auditor
  audience). saas/enron/markets are still seeded on the host so controls and the
  Enron page can go live later, but the demo UI and `run_canonical`/`verify_audit`
  default to `municipal`.
- **Live, canonical tools only.** Anon callers are the `standard` tier (no
  Anthropic key, no cost). `execute_financial_query` stays `auditor`-gated and off.
- **Proxy stays on Supabase.**

### What shipped in `66676d3`
- `Dockerfile`, `.dockerignore`, `fly.toml` (repo root) — Fly image, `cc-auditor
  serve`, warehouses baked at build, audit chain on `/data` volume, token as secret.
- `supabase/functions/query/index.ts` — rebranded; `sanitize()` forwards the
  municipal named-query params; `verify_audit`/free-text default to `municipal`.
- `site/demo.html` + `site/assets/demo.js` — live municipal query builder
  (grant-status / spending-by-vendor / budget-variance) → rows, integrity checks,
  findings, provenance, verify-chain; synthetic + not-a-professional-opinion
  banners; sample fallback when no proxy set. Linked from `index.html` and `/demo`.
- All `site/*.html` + `netlify.toml` rebranded off "Vanguard"; proxy vars are now
  `CIVIC_PROXY_URL` / `CIVIC_AUTH_TOKEN`.
- `deploy/README.md` runbook; `CHANGELOG.md` `[Unreleased]`.

### Verified locally (what to trust)
- Engine over HTTP: `/health`, `/tools` (401 without token), `run_canonical
  municipal/grant-status G-402` → rows + `integrity: pass` + a `flag` finding
  (cash drawn ahead of spending) + result/audit hashes, `verify_audit municipal`
  → INTACT.
- Full browser `{tool,args}` → proxy → engine contract via a Node shim mirroring
  the edge function: junk args stripped, `dept_id=PW` passes through, verify
  defaults to the municipal log.
- `node --check site/assets/demo.js` passes.

### NOT verified here (do before trusting prod)
- The **Deno proxy file was never executed** (no Deno/supabase CLI in this env).
  Run `supabase functions serve query` and smoke it before deploying.
- Nothing was deployed; no Docker build was run (logic was exercised directly
  under Node 22). Watch the first `fly deploy` build logs.

---

## Remaining steps (the deploy) — need isolated accounts

> ISOLATION IS THE POINT. Use a Fly org and a Supabase project that hold NOTHING
> from any Civic-Chain production system. If the only available account is shared
> with something real, STOP and raise it — do not co-locate. Full runbook:
> `deploy/README.md`.

1. **Fly engine.** In an isolated Fly org:
   `fly launch --no-deploy --copy-config --name civic-chain-auditor-demo` →
   `fly secrets set ENGINE_SERVICE_TOKEN="$(openssl rand -hex 32)"` →
   `fly volumes create auditor_data --size 1 --region bos` → `fly deploy`.
   Confirm `curl https://civic-chain-auditor-demo.fly.dev/health`.
2. **Supabase proxy.** In an isolated project:
   `supabase secrets set MCP_ENGINE_URL=<fly url> ENGINE_SERVICE_TOKEN=<same token>
   ALLOWED_ORIGIN=<netlify site>` → `supabase functions deploy query`.
3. **Front-end.** Set `window.CIVIC_PROXY_URL` to the function URL (in
   `site/demo.html` or a Netlify snippet); redeploy Netlify.
4. **Isolation check.** From the public URL run a grant query + verify; in the
   Network tab confirm requests go only to the Supabase function and that no
   `ENGINE_SERVICE_TOKEN` and no Fly URL ever reach the browser.

## Open decisions still outstanding (ask Justin)
- Public URL / Netlify site name — keep `vanguard-mcp.netlify.app` or move to a
  civic-chain subdomain (ties to the GitHub repo rename `Vanguard-MCP →
  Civic-Chain-Auditor`, still pending).
- Whether to ever enable the `auditor` (free-text, Anthropic-key) tier behind a
  sign-in; off by default for cost/safety.

## Follow-ups noted in code
- Shared `municipal-audit.jsonl` grows with every anon query — add rotation or
  drop the volume (ephemeral) if abused.
- Counsel sign-off on `LICENSE` (still draft) is a separate C1 open item.
- Next *build-value* milestone per the plan is **S6 (one-line npx install)**, then
  S8/S9/R1. S7 was pulled forward to collect interest.

## Prior handoffs
- `HANDOFF-2026-11-14-s7-hosted-demo.md` — the pre-build S7 plan (updated with a
  "built this session" note).

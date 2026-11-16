# S7 — Hosted demo runbook

A public, click-through demo of the **Civic-Chain Grant & Budget Auditor** running
on a server, so a prospect can try it without installing anything. Two moving
parts plus the static site:

```
 browser ──▶ Supabase Edge Function (proxy) ──▶ Fly.io engine (cc-auditor serve)
 (site/)     role gate · arg sanitiser            synthetic municipal warehouse
             engine URL + token live here only     bearer-token required
```

**Isolation is the whole point.** The engine host and the Supabase project must
live in accounts/organizations that hold **nothing** from any Civic-Chain
production system. The demo serves **synthetic data only** (the fictional Town of
Sampleton). Never co-locate it with anything real.

---

## 1. Engine on Fly.io

Files at the repo root: `Dockerfile`, `.dockerignore`, `fly.toml`. The image
bakes the synthetic warehouses at build time (municipal from its SQL seed; saas/
enron/markets via the CLI seeders) and runs `cc-auditor serve` on port 8787.

```sh
# in a Fly org isolated from Civic-Chain prod
fly launch --no-deploy --copy-config --name civic-chain-auditor-demo

# the engine refuses to start without this; the browser never sees it
fly secrets set ENGINE_SERVICE_TOKEN="$(openssl rand -hex 32)"

# persist the demo's tamper-evident audit chain across deploys
fly volumes create auditor_data --size 1 --region bos   # match primary_region

fly deploy
```

Verify:

```sh
curl https://civic-chain-auditor-demo.fly.dev/health
# → {"ok":true,"name":"civic-chain-auditor","version":"1.0.0"}
```

The `/tools`, `/tools/:name`, `/resources` routes all require
`Authorization: Bearer <ENGINE_SERVICE_TOKEN>` — only the proxy has it.

## 2. Proxy on Supabase

`supabase/functions/query/index.ts` (Deno). It verifies the caller's role, gates
which tool the role may call, sanitises arguments, and forwards to the engine.
Anon callers are the public `standard` tier (list_controls, run_control,
run_canonical, verify_audit); the credentialed `execute_financial_query` tier is
`auditor`-only and off for the public demo.

```sh
supabase link --project-ref <isolated-project-ref>
supabase secrets set \
  MCP_ENGINE_URL="https://civic-chain-auditor-demo.fly.dev" \
  ENGINE_SERVICE_TOKEN="<the same token from step 1>" \
  ALLOWED_ORIGIN="https://<the-netlify-site>"
supabase functions deploy query
```

The proxy defaults `verify_audit` and free-text to the `municipal` warehouse; a
caller may name another known built-in (`enron`, `saas`, `markets`) to verify its
chain, but never a file path.

## 3. Front-end on Netlify

`site/` is published as-is (no build step; see root `netlify.toml`). Point the
demo page at the proxy by setting the edge-function URL once:

- Edit `site/assets/demo.js` → `PROXY_URL`, **or**
- set `window.CIVIC_PROXY_URL` before the script loads (e.g. a Netlify snippet).

`site/demo.html` is the live municipal demo; `index.html` links to it. Every
demo surface carries the synthetic-data + "not a professional audit opinion"
notice.

## 4. End-to-end check (as the public sees it)

1. Open the Netlify site, go to **Try the live demo**.
2. Run a grant-status query (e.g. grant `G-402`). Confirm rows, the integrity
   checks, and the finding flag render, and that the result + audit hashes show.
3. Click **Verify the audit chain** → `INTACT`.
4. In the browser Network tab, confirm requests go **only** to the Supabase
   function URL and that **no `ENGINE_SERVICE_TOKEN` and no Fly URL** appear in
   any client payload.

---

## Notes / follow-ups

- **Cost/safety tier.** The public demo stays on no-credential tools
  (canonical/named queries, controls, audit verify). `execute_financial_query`
  needs an Anthropic key and bills per call; leave it gated behind the `auditor`
  role (a signed-in user) if ever enabled.
- **Shared audit log growth.** Every anon query appends to
  `/data/municipal-audit.jsonl`. Fine for a demo; add rotation (or make it
  ephemeral by dropping the volume) if it is abused.
- **Rename.** When the GitHub repo rename `Vanguard-MCP → Civic-Chain-Auditor`
  happens, move the Netlify site name off `vanguard-mcp.netlify.app` too.

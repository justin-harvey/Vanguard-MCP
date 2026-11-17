# Deploy runbook — in-browser demo (S7B)

The public demo of the **Civic-Chain Grant & Budget Auditor** runs **entirely in
the visitor's browser**. There is no engine host and no proxy: the static site
is the only moving part.

```
 browser ──▶ loads site/assets/demo-engine.js + sql-wasm.{js,wasm}
             │
             └─▶ runs the real engine locally: guard · named queries · WASM
                 SQLite (synthetic Town of Sampleton ledger) · lineage ·
                 tamper-evident audit chain (in localStorage). Nothing is sent
                 anywhere after the page loads.
```

This replaces the S7 hosted path (Fly.io engine + Supabase Edge proxy), which
has been removed from the repo. See the teardown checklist at the end for the
live cloud resources that still need to be destroyed once this is deployed.

---

## 1. Build the bundle

From `vanguard-core/` (Node ≥ 22):

```sh
npm install           # dev deps: esbuild, sql.js
npm run build:demo
```

This writes, under `site/assets/`:

- `demo-engine.js` — the engine + page controller, one ES module, with the seed
  SQL and the allow-list inlined from `skills/civic-chain-auditor/assets/`
- `sql-wasm.js`, `sql-wasm.wasm` — the self-hosted SQLite WebAssembly build

The built files are **committed**, so Netlify needs no build step. Re-run after
any change to the engine or the skill assets, and commit the result. The script
prints the transferred size (budget: ~1.5 MB; currently ~1.0 MB).

## 2. Front-end on Netlify

`site/` is published as-is (no build step; see root `netlify.toml`). That file
also sets the Content-Security-Policy that locks the page down:
`script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'` — the page cannot
phone home, which is the privacy claim enforced in the server response, not just
asserted in copy. `demo.html` loads `sql-wasm.js` then `demo-engine.js`.

## 3. End-to-end check (as the public sees it)

Either open the deployed site, or locally from `vanguard-core/`:

```sh
node scripts/verify-demo.mjs   # headless Chromium; needs a local playwright
```

It asserts: the engine loads, a query returns a real 64-hex result hash, the
audit chain verifies `INTACT`, tampering is caught (`BROKEN`), reset clears it,
the guard refuses `payroll` / `vendors.tax_id`, there are **zero network
requests after load**, and there are no CSP violations.

Manually, open **Run the live demo** and confirm the same in the browser Network
tab: assets load, then nothing.

---

## Decommission the old hosted path

The repo files (`Dockerfile`, `.dockerignore`, `fly.toml`, `supabase/`) are
already removed. The live cloud resources must be destroyed **after** this demo
is deployed and verified:

- [ ] Destroy the Fly app `civic-chain-auditor-demo` and its `auditor_data` volume
- [ ] Delete the Supabase `query` function and its secrets (`MCP_ENGINE_URL`,
      `ENGINE_SERVICE_TOKEN`, `ALLOWED_ORIGIN`); revoke the engine token
- [ ] Close or pause the isolated Fly / Supabase accounts if nothing else uses them

`cc-auditor serve` (the HTTP API) stays in the engine for enterprise use; it
already refuses to start without `ENGINE_SERVICE_TOKEN` (verified in
`bin/vanguard.js`), so there is no open unauthenticated port to leave behind.

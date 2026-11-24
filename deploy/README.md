# Deploy runbook — in-browser demo (S7B)

The public demo of the **Civic-Chain Grant & Budget Auditor** runs **entirely in
the visitor's browser**. There is no engine host and no proxy: the static site
is the only moving part.

```
 browser ──▶ loads site/assets/demo-bundle.js + sql-wasm.{js,wasm}
             │
             └─▶ runs the real engine locally: guard · named queries · WASM
                 SQLite · lineage · tamper-evident audit chain (in
                 localStorage), over three kinds of data — a CSV the visitor
                 imports on the page, a small editable sandbox, and the
                 synthetic Town of Sampleton ledger. Nothing (no file, question
                 or result) is sent anywhere after the page loads.
```

This replaces the S7 hosted path (Fly.io engine + Supabase Edge proxy), which
has been removed from the repo. See the teardown checklist at the end for the
live cloud resources that still need to be destroyed once this is deployed.

---

## 1. Build the bundle

From `auditor-core/` (Node ≥ 22):

```sh
npm install           # dev deps: esbuild, sql.js
npm run build:demo
```

This writes, under `site/assets/`:

- `demo-bundle.js` — the engine + all three `demo.html` page controllers (CSV
  import, the plain-English sandbox, and the municipal ledger), one ES module,
  with the seed SQL and the allow-list inlined from
  `skills/civic-chain-auditor/assets/`. The three controllers share one copy of
  the engine and the SQLite parser instead of shipping it three times.
- `sql-wasm.js`, `sql-wasm.wasm` — the self-hosted SQLite WebAssembly build

The built files are **committed**, so Netlify needs no build step. Re-run after
any change to the engine or the skill assets, and commit the result. The script
prints the transferred size (budget: ~1.5 MB; currently ~1.0 MB).

## 2. Front-end on Netlify

`site/` is published as-is (no build step; see root `netlify.toml`). `demo.html`
loads `sql-wasm.js` then `demo-bundle.js`. After load the page makes no request
to any engine, proxy or Civic-Chain host — the privacy claim is that no file,
question or result leaves the browser (the only third-party load is the Google
Fonts stylesheet in the page `<head>`). Note: a `Content-Security-Policy` header
(`script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`, with the font CDN
allowed) is a recommended hardening but is **not** yet set in `netlify.toml`.

## 3. End-to-end check (as the public sees it)

Either open the deployed site, or locally from `auditor-core/`:

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
`bin/auditor.js`), so there is no open unauthenticated port to leave behind.

# Security Policy

Civic-Chain Grant & Budget Auditor, from [civic-chain.com](https://civic-chain.com).

## Reporting a vulnerability

Email **info@civic-chain.com** with "SECURITY" in the subject. Please include
what you found, how to reproduce it, and the version or commit you were running.
We will acknowledge your report and work with you on a fix. Do not open a public
issue for a security problem.

If you have a public key preference for encrypted disclosure, say so in your
first message and we will arrange it.

## What runs where

The auditor runs **locally**. The engine, the database, and the audit log all
live on the machine you run it on.

- **No telemetry.** The package phones no home, reports no usage, and sends no
  analytics.
- **No Civic-Chain servers in the data path.** A free-text question that needs a
  query planner calls the model provider you configure with your own API key,
  and nothing else leaves the machine. The credential-free tools
  (`run_canonical`, `run_query`, `verify_answer`, `run_control`, `verify_audit`,
  CSV import) make no network call at all.
- **Read-only by construction.** Every query is parsed, held to a per-warehouse
  table/column allow-list, and refused unless it is a single read-only `SELECT`.
  The guard is the trust boundary.

## Verifying the ruleset signing key

Signed rulesets are signed with an **Ed25519** key held offline. The matching
public key ships with the package so you can verify a ruleset's signature
yourself, and pin the key you trust.

- **Public key:** `assets/civic-chain-ruleset-pub.pem`
- **Key id** (first 16 hex of the SHA-256 of the SPKI DER, recorded on every
  signed entry as `signedBy`): `acb80e87885da931`
- **Full SPKI DER SHA-256 fingerprint:**
  `acb80e87885da9317ae908d39f0f050a4da5ca6f72e8e547870cbed6e271a5bc`

Recompute the fingerprint to confirm the key you have is the key we publish:

```sh
openssl pkey -pubin -in assets/civic-chain-ruleset-pub.pem \
  -outform DER | openssl dgst -sha256
```

The first 16 hex of that digest is the key id. A ruleset whose `signedBy` does
not match this key id was not signed by Civic-Chain; treat it as untrusted.

The private key is never committed to this repository and never leaves an
offline machine.

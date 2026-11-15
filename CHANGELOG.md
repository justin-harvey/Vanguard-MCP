# Changelog

All notable changes to the Civic-Chain Grant & Budget Auditor are recorded here.
The project follows [Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH.

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

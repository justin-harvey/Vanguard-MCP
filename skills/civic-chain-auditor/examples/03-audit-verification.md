# Example: verifying the audit chain

Every query the agent runs appends a hash-chained entry to the warehouse's audit log. On request, the agent verifies that chain is intact. This continues the session from `01-grant-status-finding.md`, where one `municipal/grant-status` query was run, so the municipal log holds a single entry.

---

**User:** Is the municipal audit log intact?

**Agent:**

```json
verify_audit { "warehouse": "municipal" }
```

**Tool result:**

```json
{
  "logPath": "/path/to/assets/municipal-audit.jsonl",
  "ok": true,
  "entries": 1,
  "brokenAt": null,
  "reason": null
}
```

**Agent:**

> The municipal audit log is **INTACT**. The hash chain verifies across all **1** entry, with no break (`brokenAt: null`). That entry is the `municipal/grant-status` query from earlier; its entry hash was `fe4feeed7731eb05da39a418d63e54daa3d47f1b7d58edb8c3db26850ae862a3`.
>
> One caveat: over MCP, `verify_audit` checks the **hash chain** only, not Ed25519 signatures. For a signature check, run `node bin/vanguard.js audit` with a signing key configured, or for a PASS/EXCEPTION evidence result call `run_control { "id": "CC7.2-audit-chain-integrity" }` (over MCP the log is chosen on the server, not passed as a file path).

If the log had been tampered with, the result would instead carry `ok: false`, a `brokenAt` index, and a `reason`. The agent would report **BROKEN** at that index, note that entries before it still verify, and that the flagged entry and everything after it are suspect.

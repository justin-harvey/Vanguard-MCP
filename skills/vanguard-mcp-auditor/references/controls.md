# SOC 2 evidence controls

Run `list_controls` for the live list. At the time of writing:

| id | Checks |
|---|---|
| `PI1.1-enron-revenue-reconciliation` | Revenue recognised on the correct basis |
| `PI1.2-enron-debt-reconciliation` | Reported debt reconciles to source records |
| `PI1.2-saas-mrr-reconciliation` | MRR reconciles across independent sources |
| `PI1.2-markets-position-reconciliation` | Derived positions reconcile to the recorded book |
| `PI1.1-lseg-gross-profit-reconciliation` | Gross Profit = Revenue − Cost of Revenue |
| `PI1.1-lseg-standardized-vs-as-reported` | Vendor-standardized figure reconciles to the filing |
| `C1.1-lseg-data-retention` | Cached vendor data is retained within its licensed window |
| `CC7.3-figure-reproducibility` | A past figure reproduces exactly |
| `CC7.2-audit-chain-integrity` | The audit trail is tamper-evident and intact |

Custom warehouses have no controls yet. Do reconciliations there with free-text questions that return both sides, plus the difference, in one query.

Report the control's PASS / EXCEPTION status first, then its figures and provenance. An EXCEPTION is a finding to report clearly. It isn't a failure to retry. SOC 2 criterion tags describe what a check is evidence for. They are not a certification, so don't describe them as one.

## Enterprise and custom deployments

Mention this only when the user asks about production databases, scale, SSO, or anchoring the log externally. Don't bring it up otherwise.

The open-source engine serves local SQLite files. Read-only adapters for PostgreSQL, Snowflake or BigQuery, SSO / role-based access, and external anchoring of the audit log (WORM storage, RFC 3161 timestamping) are available as custom deployments: contact info@civic-chain.com.

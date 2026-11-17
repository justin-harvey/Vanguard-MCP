/**
 * The Canonical Municipal Schema, v1 — the one definition of the shape every
 * municipal ledger takes.
 *
 * Before this module the schema was written out twice: the importer carried its
 * own `SCHEMA_DDL` (src/import-csv.js) and the demo seed carried the same
 * `CREATE TABLE`s inline (assets/municipal/sample_municipal_budget.sql). Two
 * copies drift: a column added to one and not the other is a silent break the
 * next time a buyer imports a CSV and runs a query that assumes the demo's
 * shape. So the DDL lives here once, the importer builds from it, and
 * test/schema-drift.test.js pins the demo seed and the allow-list back to it.
 *
 * Keyed on CANONICAL_SCHEMA_VERSION (pinned by S9: the bundled ruleset's
 * version must equal it). This file is pure — no `node:` imports — so the
 * browser build can inline it alongside the engine.
 */

/** The schema version the importer targets and the bundled ruleset is signed for. */
export const CANONICAL_SCHEMA_VERSION = 'municipal-v1';

// ── canonical schema v1 ─────────────────────────────────────────────────────
//
// The seven tables a municipal ledger is made of. The demo seed adds its sample
// data (and a deliberately non-allow-listed `payroll` table, so the guard has
// something to refuse); the importer builds these empty and derives the rows
// from a buyer's CSV. The two must stay column-for-column identical, which is
// what the drift test proves.
export const CANONICAL_SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE funds (
  fund_id   TEXT PRIMARY KEY,
  fund_name TEXT NOT NULL,
  fund_type TEXT NOT NULL
);

CREATE TABLE departments (
  dept_id   TEXT PRIMARY KEY,
  dept_name TEXT NOT NULL
);

CREATE TABLE vendors (
  vendor_id            TEXT PRIMARY KEY,
  vendor_name          TEXT NOT NULL,
  category             TEXT NOT NULL,
  tax_id               TEXT NOT NULL,
  remit_account_last4  TEXT NOT NULL
);

CREATE TABLE grants (
  grant_id              TEXT PRIMARY KEY,
  grant_name            TEXT NOT NULL,
  grantor               TEXT NOT NULL,
  grantor_type          TEXT NOT NULL CHECK (grantor_type IN ('federal', 'state', 'county', 'private')),
  fund_id               TEXT NOT NULL REFERENCES funds(fund_id),
  dept_id               TEXT NOT NULL REFERENCES departments(dept_id),
  award_cents           INTEGER NOT NULL,
  match_required_cents  INTEGER NOT NULL,
  period_start          TEXT NOT NULL,
  period_end            TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('active', 'closed'))
);

CREATE TABLE budget_lines (
  line_id           TEXT PRIMARY KEY,
  fiscal_year       INTEGER NOT NULL,
  dept_id           TEXT NOT NULL REFERENCES departments(dept_id),
  fund_id           TEXT NOT NULL REFERENCES funds(fund_id),
  account_code      TEXT NOT NULL,
  line_description  TEXT NOT NULL,
  adopted_cents     INTEGER NOT NULL,
  amended_cents     INTEGER NOT NULL
);

CREATE TABLE expenditures (
  expenditure_id  TEXT PRIMARY KEY,
  fiscal_year     INTEGER NOT NULL,
  line_id         TEXT NOT NULL REFERENCES budget_lines(line_id),
  grant_id        TEXT REFERENCES grants(grant_id),
  vendor_id       TEXT NOT NULL REFERENCES vendors(vendor_id),
  invoice_number  TEXT NOT NULL,
  invoice_date    TEXT NOT NULL,
  paid_date       TEXT,
  amount_cents    INTEGER NOT NULL,
  memo            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('paid', 'pending', 'void'))
);

CREATE TABLE grant_drawdowns (
  drawdown_id   TEXT PRIMARY KEY,
  grant_id      TEXT NOT NULL REFERENCES grants(grant_id),
  request_date  TEXT NOT NULL,
  received_date TEXT,
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('received', 'pending'))
);
`;

/** The canonical tables, in declaration order — the names the drift test pins. */
export const CANONICAL_SCHEMA_TABLES = Object.freeze([
    'funds', 'departments', 'vendors', 'grants', 'budget_lines', 'expenditures', 'grant_drawdowns',
]);

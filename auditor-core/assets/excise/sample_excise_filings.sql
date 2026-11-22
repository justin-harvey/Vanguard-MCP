-- Penobscot Bay Brewing Co. (FICTIONAL) beer excise filings.
--
-- Synthetic demo data for the civic-chain-auditor skill's Excise Tax pack.
-- Every name, figure, return and customer here is invented; Penobscot Bay is
-- not a real brewery. All money is INTEGER CENTS and all volume is INTEGER
-- BARRELS (the barrel is the beer excise unit; a US beer barrel is 31 gallons).
--
-- A brewer owes federal excise on beer removed from bond for consumption or
-- sale (27 CFR part 25), reports those removals and production on an operations
-- report (TTB F 5130.9) due by the 15th after each period (27 CFR 25.297), and
-- pays the tax on an excise return. The five controls reconcile what was
-- produced, what was removed, what was reported and what was paid, the same
-- evidence a TTB or state revenue auditor builds a case from.
--
-- Rates are DATA, not code. tax_rates carries the per-barrel rate with an
-- effective date, so a rate change is a row, never a new signed ruleset. The
-- demo ships two rates: the old 700-cents full rate (effective 2025-01-01) and
-- the 350-cents reduced small-brewer rate the Craft Beverage Modernization Act
-- set (effective 2026-01-01). A control reconciling a 2026 period must pick the
-- 2026 rate; picking the stale 2025 rate would double the expected tax, so the
-- clean PASS below is also proof the effective-date selection works.
--
-- The data is deliberately CLEAN so all five Excise controls read PASS out of
-- the box, the same way the municipal, insurance and IOLTA demos keep their
-- default seeds clean:
--   * liability-vs-remitted: tax paid each period equals taxable removals
--     (barrels) times the 350-cents reduced rate, so the return is not short.
--     2026-01: 400 barrels x 350 = 140,000 paid; 2026-02: 500 x 350 = 175,000.
--   * inventory-rollforward: opening + produced - removed - losses = closing,
--     for every period, so no product left without being accounted for.
--     2026-01: 100 + 450 - 400 - 10 = 140; 2026-02: 140 + 520 - 500 - 10 = 150.
--   * report-vs-return: the barrels removed on the operations report equal the
--     barrels reported on the tax return, period for period (400 and 500).
--   * missing-or-late-filings: every period with activity has a return, and
--     each was filed on or before its 15th-of-next-month due date.
--   * loss-variance: losses as a fraction of production (222 and 192 basis
--     points) are under the 300-bps default tolerance; the 2026-01 period
--     surfaces only at a tighter threshold.
--
-- One detail exists so the engine's safeguard is visible on the demo data:
--   * customer_accounts is deliberately NOT in sample_excise_allowlist.json (it
--     holds the names and addresses of the wholesale accounts beer is sold to,
--     and would hold patient-registry IDs in a cannabis build), so the guard
--     refuses any query that reaches it. This backs the pack's "no customer
--     data" claim: the controls reconcile volumes and money by period only.

PRAGMA foreign_keys = ON;

-- The excise rate schedule. One row per (product class, jurisdiction) that took
-- effect on a date; a control reads the row whose effective_date is the latest
-- on or before the period it is reconciling. Because the rate lives here and
-- not in the ruleset, a rate change is a data update, not a new signed version.
CREATE TABLE tax_rates (
  rate_id               TEXT PRIMARY KEY,
  product_class         TEXT NOT NULL,          -- e.g. BEER
  jurisdiction          TEXT NOT NULL,          -- e.g. US-TTB
  rate_cents_per_barrel INTEGER NOT NULL CHECK (rate_cents_per_barrel >= 0),
  effective_date        TEXT NOT NULL           -- YYYY-MM-DD; the rate applies from this date forward
);

-- Taxable removals: beer leaving bond for consumption or sale, the event that
-- creates the excise liability. One row per removal; period is YYYY-MM.
CREATE TABLE removals (
  removal_id    TEXT PRIMARY KEY,
  period        TEXT NOT NULL,                  -- YYYY-MM filing period
  product_class TEXT NOT NULL,
  barrels       INTEGER NOT NULL CHECK (barrels >= 0),
  removal_date  TEXT NOT NULL
);

-- The operations report (TTB F 5130.9 for beer): the period's production
-- rollforward. opening + produced - removed - losses must equal closing, and
-- removed must agree with the tax return. loss_barrels is destruction, spillage
-- and shrinkage; a large loss is a diversion signal.
CREATE TABLE operations_reports (
  report_id        TEXT PRIMARY KEY,
  period           TEXT NOT NULL,
  product_class    TEXT NOT NULL,
  opening_barrels  INTEGER NOT NULL CHECK (opening_barrels >= 0),
  produced_barrels INTEGER NOT NULL CHECK (produced_barrels >= 0),
  removed_barrels  INTEGER NOT NULL CHECK (removed_barrels >= 0),
  loss_barrels     INTEGER NOT NULL CHECK (loss_barrels >= 0),
  closing_barrels  INTEGER NOT NULL CHECK (closing_barrels >= 0),
  filed_date       TEXT NOT NULL,
  due_date         TEXT NOT NULL                -- the 15th of the month after the period
);

-- The excise return (TTB F 5000.24 and the state analogue): the barrels the
-- brewer reported removing and the tax it paid for the period. due_date is the
-- 15th of the next month; a filed_date past it is a late filing.
CREATE TABLE tax_returns (
  return_id        TEXT PRIMARY KEY,
  period           TEXT NOT NULL,
  product_class    TEXT NOT NULL,
  barrels_reported INTEGER NOT NULL CHECK (barrels_reported >= 0),
  tax_paid_cents   INTEGER NOT NULL CHECK (tax_paid_cents >= 0),
  filed_date       TEXT NOT NULL,
  due_date         TEXT NOT NULL
);

-- Not allow-listed: present so the guard has something to refuse. Holds the
-- wholesale-account customer data (names, addresses, license numbers) the pack
-- promises never to read; a cannabis build would add patient-registry IDs here.
CREATE TABLE customer_accounts (
  account_id     TEXT PRIMARY KEY,
  customer_name  TEXT NOT NULL,   -- sensitive: not allow-listed
  street_address TEXT,            -- sensitive: not allow-listed
  license_number TEXT             -- sensitive: not allow-listed
);

-- ── rate schedule ────────────────────────────────────────────────────────────
-- The 2025 full rate and the 2026 reduced small-brewer rate. The 2026 periods
-- below must resolve to 350; the 2025 row is here to prove the control takes
-- the latest effective rate on or before the period, not the first or largest.
INSERT INTO tax_rates (rate_id, product_class, jurisdiction, rate_cents_per_barrel, effective_date) VALUES
  ('RATE-BEER-2025', 'BEER', 'US-TTB', 700, '2025-01-01'),
  ('RATE-BEER-2026', 'BEER', 'US-TTB', 350, '2026-01-01');

-- ── taxable removals ─────────────────────────────────────────────────────────
-- Two periods. The per-period totals drive both the liability (barrels x rate)
-- and the report-vs-return tie-out:
--   2026-01: 250 + 150 = 400 barrels
--   2026-02: 300 + 200 = 500 barrels
INSERT INTO removals (removal_id, period, product_class, barrels, removal_date) VALUES
  ('RM-0001', '2026-01', 'BEER', 250, '2026-01-09'),
  ('RM-0002', '2026-01', 'BEER', 150, '2026-01-23'),
  ('RM-0010', '2026-02', 'BEER', 300, '2026-02-07'),
  ('RM-0011', '2026-02', 'BEER', 200, '2026-02-20');

-- ── operations reports ───────────────────────────────────────────────────────
-- Each period's rollforward ties (opening + produced - removed - losses =
-- closing) and the closing barrels carry into the next period's opening.
--   2026-01: 100 + 450 - 400 - 10 = 140
--   2026-02: 140 + 520 - 500 - 10 = 150
INSERT INTO operations_reports (report_id, period, product_class, opening_barrels, produced_barrels, removed_barrels, loss_barrels, closing_barrels, filed_date, due_date) VALUES
  ('OR-2026-01', '2026-01', 'BEER', 100, 450, 400, 10, 140, '2026-02-10', '2026-02-15'),
  ('OR-2026-02', '2026-02', 'BEER', 140, 520, 500, 10, 150, '2026-03-12', '2026-03-15');

-- ── excise returns ───────────────────────────────────────────────────────────
-- Barrels reported match the operations reports' removed barrels, tax paid is
-- barrels x 350, and both returns were filed on or before the 15th.
INSERT INTO tax_returns (return_id, period, product_class, barrels_reported, tax_paid_cents, filed_date, due_date) VALUES
  ('TR-2026-01', '2026-01', 'BEER', 400, 140000, '2026-02-12', '2026-02-15'),
  ('TR-2026-02', '2026-02', 'BEER', 500, 175000, '2026-03-14', '2026-03-15');

-- ── customer accounts (NOT allow-listed) ─────────────────────────────────────
INSERT INTO customer_accounts (account_id, customer_name, street_address, license_number) VALUES
  ('A-100', 'Casco Bay Distributing LLC', '55 Commercial St, Portland, ME', 'ME-WHL-2211'),
  ('A-200', 'Downeast Beverage Co.',      '12 Marsh Rd, Bangor, ME',        'ME-WHL-4087');

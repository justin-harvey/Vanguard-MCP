-- Granite State Builders (FICTIONAL) construction-contract ledger.
--
-- Synthetic demo data for the civic-chain-auditor skill's Construction Contracts
-- pack. Every name, job, figure and date here is invented; Granite State
-- Builders is not a real contractor. All money is INTEGER CENTS, and percent
-- complete and estimated margin are INTEGER BASIS POINTS (10000 bps = 100
-- percent), so the SQL never needs floating point.
--
-- A contractor's financial statements turn on the work-in-progress (WIP)
-- schedule, the thing a surety or a lender scrutinizes before extending bonding
-- or credit. The six controls reconcile it:
--   * wip-schedule. ASC 606 recognizes revenue over time by the cost-to-cost
--     method: a job's percent complete is cost to date over estimated cost at
--     completion, and its earned revenue is the contract value times that
--     percent. The schedule reports earned revenue per job, and the earned total
--     must tie to the revenue recognized in the general ledger (gl_revenue).
--   * billings-tie-out. Where billings run ahead of earned revenue the job is
--     overbilled (a contract liability); where earnings run ahead of billings it
--     is underbilled (a contract asset). The totals must tie to the
--     CONTRACT_LIABILITY and CONTRACT_ASSET balances on the balance sheet.
--   * loss-jobs. A job whose estimated cost exceeds its contract value is a loss
--     job; ASC 606 recognizes the full estimated loss as soon as it is known.
--   * margin-fade. A job whose estimated gross margin has slipped since the last
--     WIP snapshot is fading, the classic early warning on a WIP schedule.
--   * retainage-reconciles. Retainage is earned and billed but held back, so the
--     carried receivable must equal withheld less released.
--   * payments-without-lien-waiver. A subcontractor payment released without its
--     lien waiver leaves the owner and the contractor exposed to a mechanic's
--     lien.
--
-- The governing references are ASC 606 over-time (cost-to-cost) revenue
-- recognition and the WIP schedule it drives, and AIA G702 / G703 progress
-- billing with retainage; the specific jobs and dollar amounts are modeled for
-- the demo.
--
-- Tolerances are PARAMETERS, not code: margin-fade takes fade_bps, defaulting to
-- 300 (a 3 percentage-point fall), so a surety or lender with a different
-- tolerance passes its own number rather than editing the ruleset.
--
-- The data is deliberately CLEAN so all six Construction controls read PASS out
-- of the box, the same way the municipal, insurance, IOLTA, excise, property/HOA,
-- nonprofit and schools demos keep their default seeds clean:
--   * wip-schedule: each job's earned revenue is contract value times cost to
--     date over estimated cost, and the earned total (1,700,000.00) ties to the
--     general-ledger revenue total.
--   * billings-tie-out: total overbillings (100,000.00) equal the contract
--     liability, and total underbillings (40,000.00) the contract asset.
--   * loss-jobs: every job's estimated cost is within its contract value.
--   * margin-fade: every job's margin has slipped less than the 300-bps default
--     since its last snapshot.
--   * retainage-reconciles: each job's carried receivable equals withheld less
--     released.
--   * payments-without-lien-waiver: every subcontractor payment carries a waiver.
--
-- One detail exists so the engine's safeguard is visible on the demo data:
--   * payroll_pii is deliberately NOT in sample_construction_allowlist.json (it
--     holds employee names, Social Security numbers, hourly pay rates and
--     certified-payroll classifications), so the guard refuses any query that
--     reaches it. This backs the pack's "no employee pay data" claim: the
--     controls reconcile jobs, billings, retainage and subcontractor payments by
--     code only.

PRAGMA foreign_keys = ON;

-- The jobs under contract. contract_value_cents is the current contract value
-- including approved change orders; estimated_cost_cents is the current total
-- estimated cost at completion; cost_to_date_cents is the cost incurred so far;
-- billed_to_date_cents is progress billed so far. Earned revenue is
-- contract_value_cents * cost_to_date_cents / estimated_cost_cents (cost-to-cost).
CREATE TABLE jobs (
  job_id               TEXT PRIMARY KEY,
  job_name             TEXT NOT NULL,
  status               TEXT NOT NULL,            -- OPEN | CLOSED
  contract_value_cents INTEGER NOT NULL CHECK (contract_value_cents > 0),
  estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents > 0),
  cost_to_date_cents   INTEGER NOT NULL CHECK (cost_to_date_cents >= 0),
  billed_to_date_cents INTEGER NOT NULL CHECK (billed_to_date_cents >= 0)
);

-- Revenue recognized in the general ledger, per job. wip-schedule ties the sum
-- of earned revenue it computes to the sum of this table.
CREATE TABLE gl_revenue (
  entry_id     TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  posted_date  TEXT NOT NULL                     -- YYYY-MM-DD
);

-- The contract-liability (billings in excess) and contract-asset (costs in
-- excess) balances carried on the balance sheet. billings-tie-out reconciles the
-- summed over- and underbillings to these.
CREATE TABLE balance_sheet_balances (
  account       TEXT PRIMARY KEY,                -- CONTRACT_LIABILITY | CONTRACT_ASSET
  balance_cents INTEGER NOT NULL,
  as_of         TEXT NOT NULL                    -- YYYY-MM-DD
);

-- Prior work-in-progress snapshots, used to measure margin fade. margin-fade
-- reads the latest snapshot per job (MAX(snapshot_date)) and compares its margin
-- to the current margin on the jobs table.
CREATE TABLE wip_snapshots (
  snapshot_id          TEXT PRIMARY KEY,
  job_id               TEXT NOT NULL,
  snapshot_date        TEXT NOT NULL,            -- YYYY-MM-DD of the snapshot
  contract_value_cents INTEGER NOT NULL CHECK (contract_value_cents > 0),
  estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents > 0)
);

-- Retainage per job: withheld and released to date, and the receivable carried.
-- retainage-reconciles checks receivable_cents = withheld_cents - released_cents.
CREATE TABLE retainage (
  job_id          TEXT PRIMARY KEY,
  withheld_cents  INTEGER NOT NULL CHECK (withheld_cents >= 0),
  released_cents  INTEGER NOT NULL CHECK (released_cents >= 0),
  receivable_cents INTEGER NOT NULL
);

-- Subcontractor payments. lien_waiver_received is 1 when the waiver is on file,
-- 0 when it is missing; payments-without-lien-waiver flags any payment released
-- without one. Subcontractors are identified by subcontractor_id only.
CREATE TABLE sub_payments (
  payment_id          TEXT PRIMARY KEY,
  job_id              TEXT NOT NULL,
  subcontractor_id    TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents >= 0),
  payment_date        TEXT NOT NULL,            -- YYYY-MM-DD
  lien_waiver_received INTEGER NOT NULL         -- 1 = waiver on file, 0 = missing
);

-- Not allow-listed: present so the guard has something to refuse. Holds the
-- employee names, Social Security numbers, hourly pay rates and certified-payroll
-- classifications. The controls never read it; they work from job, subcontractor
-- and balance codes only.
CREATE TABLE payroll_pii (
  employee_id      TEXT PRIMARY KEY,
  employee_name    TEXT NOT NULL,   -- sensitive: not allow-listed
  ssn              TEXT,            -- sensitive: not allow-listed
  hourly_rate_cents INTEGER,        -- sensitive: not allow-listed
  payroll_class    TEXT             -- sensitive: certified-payroll classification, not allow-listed
);

-- ── jobs (cost-to-cost; every estimated cost within its contract value) ───────
-- Earned revenue = contract * cost_to_date / estimated_cost:
--   J-100  200,000,000 * 80,000,000 / 160,000,000 = 100,000,000 (50% complete)
--   J-200   80,000,000 * 30,000,000 /  60,000,000 =  40,000,000 (50% complete)
--   J-300  120,000,000 * 24,000,000 /  96,000,000 =  30,000,000 (25% complete)
-- Earned total 170,000,000 ties to gl_revenue. Over/underbillings:
--   J-100 billed 110,000,000 - earned 100,000,000 = overbilled  10,000,000
--   J-200 billed  36,000,000 - earned  40,000,000 = underbilled  4,000,000
--   J-300 billed  30,000,000 - earned  30,000,000 = even
INSERT INTO jobs (job_id, job_name, status, contract_value_cents, estimated_cost_cents, cost_to_date_cents, billed_to_date_cents) VALUES
  ('J-100', 'Riverside School Addition',     'OPEN', 200000000, 160000000, 80000000, 110000000),
  ('J-200', 'Harbor Bridge Rehabilitation',  'OPEN',  80000000,  60000000, 30000000,  36000000),
  ('J-300', 'Downtown Parking Garage',       'OPEN', 120000000,  96000000, 24000000,  30000000);

-- ── general-ledger revenue (sums to the earned total, 170,000,000) ────────────
INSERT INTO gl_revenue (entry_id, job_id, amount_cents, posted_date) VALUES
  ('GLR-1', 'J-100', 60000000, '2026-03-31'),
  ('GLR-2', 'J-100', 40000000, '2026-06-30'),
  ('GLR-3', 'J-200', 40000000, '2026-06-30'),
  ('GLR-4', 'J-300', 30000000, '2026-06-30');

-- ── balance-sheet contract balances (tie to the over/underbilling totals) ─────
INSERT INTO balance_sheet_balances (account, balance_cents, as_of) VALUES
  ('CONTRACT_LIABILITY', 10000000, '2026-06-30'),  -- = total overbillings
  ('CONTRACT_ASSET',      4000000, '2026-06-30');   -- = total underbillings

-- ── prior WIP snapshots (latest per job; each margin slipped < 300 bps) ───────
-- Current margins: J-100 (200-160)/200 = 2000 bps; J-200 (80-60)/80 = 2500 bps;
-- J-300 (120-96)/120 = 2000 bps. Latest snapshot (2026-06-30) margins are a
-- little higher, so the fall is small and clean:
--   J-100 (200-158)/200 = 2100 bps -> fade 100
--   J-200 (80-59)/80     = 2625 bps -> fade 125
--   J-300 (120-94)/120   = 2166 bps -> fade 166
-- J-100 also has an older, higher-margin snapshot (2026-03-31) that margin-fade
-- must NOT pick: its 2500 bps would read as a 500-bps fade. Selecting the latest
-- by MAX(snapshot_date) keeps the control clean, which is the point of the row.
INSERT INTO wip_snapshots (snapshot_id, job_id, snapshot_date, contract_value_cents, estimated_cost_cents) VALUES
  ('WS-100A', 'J-100', '2026-03-31', 200000000, 150000000),  -- older; must be ignored
  ('WS-100B', 'J-100', '2026-06-30', 200000000, 158000000),  -- latest
  ('WS-200',  'J-200', '2026-06-30',  80000000,  59000000),
  ('WS-300',  'J-300', '2026-06-30', 120000000,  94000000);

-- ── retainage (each carried receivable = withheld - released) ─────────────────
INSERT INTO retainage (job_id, withheld_cents, released_cents, receivable_cents) VALUES
  ('J-100', 11000000, 1000000, 10000000),
  ('J-200',  3600000,       0,  3600000),
  ('J-300',  3000000, 3000000,        0);

-- ── subcontractor payments (every one with a lien waiver on file) ─────────────
INSERT INTO sub_payments (payment_id, job_id, subcontractor_id, amount_cents, payment_date, lien_waiver_received) VALUES
  ('SP-1', 'J-100', 'SUB-STEEL',   25000000, '2026-04-15', 1),
  ('SP-2', 'J-100', 'SUB-CONCRETE', 15000000, '2026-05-20', 1),
  ('SP-3', 'J-200', 'SUB-PAVING',    8000000, '2026-05-01', 1),
  ('SP-4', 'J-300', 'SUB-ELECTRIC',  5000000, '2026-06-10', 1);

-- ── payroll (NOT allow-listed) ────────────────────────────────────────────────
INSERT INTO payroll_pii (employee_id, employee_name, ssn, hourly_rate_cents, payroll_class) VALUES
  ('EMP-1', 'Dana Whitfield', '000-00-0000', 5200, 'Carpenter'),
  ('EMP-2', 'Marcus Oyelaran', '000-00-0001', 6100, 'Ironworker');

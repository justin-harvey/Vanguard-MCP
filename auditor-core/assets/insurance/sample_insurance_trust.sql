-- Harborline Insurance Agency, Inc. (FICTIONAL) premium-trust and policy ledger.
--
-- Synthetic demo data for the civic-chain-auditor skill's Insurance & Fiduciary
-- pack. Every name, figure, carrier, policy, SSN and health note here is
-- invented; Harborline is not a real agency. All money is INTEGER CENTS.
--
-- The data is deliberately CLEAN so the three insurance controls all read PASS
-- out of the box, the same way the municipal demo's default seed keeps
-- grant-status clean:
--   * trust_account_solvency: the latest bank snapshot (70,000) covers the
--     net trust liability (67,500), so the fiduciary trust is solvent.
--   * commission_variance_audit: every active/bound policy was paid exactly its
--     contracted commission, so no policy varies by more than $1.00.
--   * eo_unbound_exposure: every policy holding client premium has a
--     carrier-confirmed binder, so there is no unbound E&O exposure.
--
-- Two details exist so the engine's safeguards are visible on the demo data:
--   * insured_pii is deliberately NOT in sample_insurance_allowlist.json (it
--     holds SSNs and health notes), so the guard refuses any query that reaches
--     it, this is what backs the pack's "no PII" claim.
--   * trust_ledger carries one PENDING client-premium row that the solvency
--     query excludes (it filters reconciled_status = 'POSTED'); if it were
--     counted the trust would look far larger than it is.

PRAGMA foreign_keys = ON;

-- Premium trust ledger: client premiums in, carrier remittances out, and the
-- agency's own commission draws. The fiduciary account the state department of
-- insurance requires be kept separate from operating cash.
CREATE TABLE trust_ledger (
  entry_id          TEXT PRIMARY KEY,
  policy_id         TEXT,                                 -- NULL for an agency-level draw
  carrier_code      TEXT,                                 -- NULL for an agency-level draw
  entry_type        TEXT NOT NULL CHECK (entry_type IN ('CLIENT_PREMIUM_IN', 'CARRIER_REMIT_OUT', 'AGENCY_COMMISSION_DRAW')),
  amount_cents      INTEGER NOT NULL,
  reconciled_status TEXT NOT NULL CHECK (reconciled_status IN ('POSTED', 'PENDING')),
  entry_date        TEXT NOT NULL
);

-- Point-in-time statements of the actual trust bank balance. The solvency
-- control compares the most recent one to the computed trust liability.
CREATE TABLE trust_bank_snapshots (
  snapshot_id              TEXT PRIMARY KEY,
  snapshot_date            TEXT NOT NULL,
  actual_bank_balance_cents INTEGER NOT NULL
);

-- Policies the agency has written, with the commission rate its carrier
-- contract specifies (in basis points, so 1500 = 15%).
CREATE TABLE policies (
  policy_id             TEXT PRIMARY KEY,
  carrier_code          TEXT NOT NULL,
  line_of_business      TEXT NOT NULL,
  written_premium_cents INTEGER NOT NULL,
  contracted_comm_bps   INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('ACTIVE', 'BOUND', 'CANCELLED'))
);

-- Commission actually paid to the agency by carriers, per policy. A policy may
-- have several receipts; the variance control sums them.
CREATE TABLE commission_receipts (
  receipt_id     TEXT PRIMARY KEY,
  policy_id      TEXT NOT NULL REFERENCES policies(policy_id),
  paid_comm_cents INTEGER NOT NULL
);

-- Carrier binders. carrier_confirmed = 1 means the carrier has confirmed
-- coverage is bound; 0 (or no row) means coverage is not yet confirmed.
CREATE TABLE binders (
  binder_id        TEXT PRIMARY KEY,
  policy_id        TEXT NOT NULL REFERENCES policies(policy_id),
  carrier_confirmed INTEGER NOT NULL CHECK (carrier_confirmed IN (0, 1)),
  effective_date   TEXT
);

-- Not allow-listed: present so the guard has something to refuse. Holds the
-- kind of PII (SSNs, health notes) the pack promises never to read.
CREATE TABLE insured_pii (
  insured_id      TEXT PRIMARY KEY,
  policy_id       TEXT,
  full_name       TEXT NOT NULL,
  ssn             TEXT NOT NULL,   -- sensitive: not allow-listed
  health_condition TEXT            -- sensitive: not allow-listed
);

-- ── policies ────────────────────────────────────────────────────────────────
-- Four active/bound policies, plus one cancelled policy to show the variance
-- query's WHERE filter excludes it.
INSERT INTO policies (policy_id, carrier_code, line_of_business, written_premium_cents, contracted_comm_bps, status) VALUES
  ('P-1001', 'CARR-ATLAS',  'COMMERCIAL_AUTO',   1200000, 1500, 'ACTIVE'),
  ('P-1002', 'CARR-ORION',  'GENERAL_LIABILITY',  800000, 1250, 'ACTIVE'),
  ('P-1003', 'CARR-ATLAS',  'PROPERTY',          2000000, 1000, 'BOUND'),
  ('P-1004', 'CARR-VERTEX', 'COMMERCIAL_AUTO',    500000, 1750, 'ACTIVE'),
  ('P-1009', 'CARR-ORION',  'PROPERTY',           300000, 1200, 'CANCELLED');

-- ── commission receipts ──────────────────────────────────────────────────────
-- Each active/bound policy is paid exactly its contracted commission:
--   P-1001 1200000 * 1500 / 10000 = 180000  (100000 + 80000)
--   P-1002  800000 * 1250 / 10000 = 100000
--   P-1003 2000000 * 1000 / 10000 = 200000  (120000 + 80000)
--   P-1004  500000 * 1750 / 10000 =  87500
-- The cancelled policy carries a receipt too; the variance query excludes it.
INSERT INTO commission_receipts (receipt_id, policy_id, paid_comm_cents) VALUES
  ('R-5001', 'P-1001', 100000),
  ('R-5002', 'P-1001',  80000),
  ('R-5003', 'P-1002', 100000),
  ('R-5004', 'P-1003', 120000),
  ('R-5005', 'P-1003',  80000),
  ('R-5006', 'P-1004',  87500),
  ('R-5009', 'P-1009',  36000);

-- ── binders ──────────────────────────────────────────────────────────────────
-- Every policy that holds client premium in trust is carrier-confirmed.
INSERT INTO binders (binder_id, policy_id, carrier_confirmed, effective_date) VALUES
  ('B-9001', 'P-1001', 1, '2026-01-05'),
  ('B-9002', 'P-1002', 1, '2026-01-12'),
  ('B-9003', 'P-1003', 1, '2026-02-01'),
  ('B-9004', 'P-1004', 1, '2026-02-15');

-- ── trust ledger ─────────────────────────────────────────────────────────────
-- Client premiums collected into trust (POSTED): 4,500,000 total.
INSERT INTO trust_ledger (entry_id, policy_id, carrier_code, entry_type, amount_cents, reconciled_status, entry_date) VALUES
  ('T-0001', 'P-1001', 'CARR-ATLAS',  'CLIENT_PREMIUM_IN', 1200000, 'POSTED', '2026-01-06'),
  ('T-0002', 'P-1002', 'CARR-ORION',  'CLIENT_PREMIUM_IN',  800000, 'POSTED', '2026-01-13'),
  ('T-0003', 'P-1003', 'CARR-ATLAS',  'CLIENT_PREMIUM_IN', 2000000, 'POSTED', '2026-02-02'),
  ('T-0004', 'P-1004', 'CARR-VERTEX', 'CLIENT_PREMIUM_IN',  500000, 'POSTED', '2026-02-16'),
  -- Carrier remittances out (POSTED): each premium less the agency's commission.
  ('T-0010', 'P-1001', 'CARR-ATLAS',  'CARRIER_REMIT_OUT', 1020000, 'POSTED', '2026-01-20'),
  ('T-0011', 'P-1002', 'CARR-ORION',  'CARRIER_REMIT_OUT',  700000, 'POSTED', '2026-01-25'),
  ('T-0012', 'P-1003', 'CARR-ATLAS',  'CARRIER_REMIT_OUT', 1800000, 'POSTED', '2026-02-10'),
  ('T-0013', 'P-1004', 'CARR-VERTEX', 'CARRIER_REMIT_OUT',  412500, 'POSTED', '2026-02-20'),
  -- Agency commission drawn to operating (POSTED): less than the 567,500 earned,
  -- so 67,500 of trust liability remains to be settled.
  ('T-0020', NULL,     NULL,          'AGENCY_COMMISSION_DRAW', 500000, 'POSTED', '2026-02-25'),
  -- A pending premium the solvency query must exclude (reconciled_status filter).
  ('T-0030', 'P-1001', 'CARR-ATLAS',  'CLIENT_PREMIUM_IN',  999999, 'PENDING', '2026-03-01');

-- ── bank snapshots ───────────────────────────────────────────────────────────
-- The later snapshot (70,000) is the one the solvency query reads; the earlier,
-- larger one (2,500,000) proves it takes the most recent by date, not the max.
INSERT INTO trust_bank_snapshots (snapshot_id, snapshot_date, actual_bank_balance_cents) VALUES
  ('S-01', '2026-01-31', 2500000),
  ('S-02', '2026-02-28',   70000);

-- ── insured PII (NOT allow-listed) ───────────────────────────────────────────
INSERT INTO insured_pii (insured_id, policy_id, full_name, ssn, health_condition) VALUES
  ('IP-1', 'P-1001', 'Dana Whitfield',  '123-45-6789', 'hypertension'),
  ('IP-2', 'P-1002', 'Marcus Allard',   '234-56-7890', NULL),
  ('IP-3', 'P-1003', 'Priya Nandakumar','345-67-8901', 'type 2 diabetes'),
  ('IP-4', 'P-1004', 'Theo Brandt',     '456-78-9012', NULL);

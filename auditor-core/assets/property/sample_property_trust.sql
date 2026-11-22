-- Sunset Key Realty & Property Management, LLC (FICTIONAL) broker trust account.
--
-- Synthetic demo data for the civic-chain-auditor skill's Property Management &
-- HOA pack (the broker/property-manager trust ruleset, property-trust-v1). Every
-- name, property, lease and figure here is invented; Sunset Key is not a real
-- brokerage. All money is INTEGER CENTS.
--
-- A Florida real estate broker holding money for others keeps it in a trust
-- (escrow) account separate from the firm's own funds and reconciles that
-- account on a schedule; the broker reviews, signs and dates the statement,
-- which itemizes the broker's trust liability (Rule 61J2-14.012). The account
-- pools two kinds of beneficiary money: owner funds (rent collected and held for
-- property owners) and tenant security deposits. The four controls reconcile
-- what the bank holds against what the broker owes, and check that tenant
-- deposits are actually in trust and returned on time.
--
-- The data is deliberately CLEAN so all four property controls read PASS out of
-- the box, the same way the municipal, insurance, IOLTA and excise demos keep
-- their default seeds clean:
--   * trust-vs-liability: the reconciled bank balance (340,000 statement − 20,000
--     outstanding checks = 320,000) is at least the itemized trust liability, the
--     sum of every beneficiary ledger (50,000 + 50,000 + 120,000 + 100,000 + 0 =
--     320,000). The account is fully funded, not short.
--   * negative-owner-balances: no owner ledger is overdrawn, so no owner's money
--     is funding another owner's disbursement.
--   * deposits-held-vs-owed: every active lease's security deposit is held in
--     trust in full (L-001 holds 120,000, L-002 holds 100,000).
--   * deposit-return-overdue: the one ended lease (L-003) had its deposit
--     returned within the window, so nothing is past the return deadline; it
--     surfaces only if the return is undone.
--
-- One detail exists so the engine's safeguard is visible on the demo data:
--   * resident_pii is deliberately NOT in sample_property_allowlist.json (it
--     holds tenant and owner names, SSNs and bank account numbers), so the guard
--     refuses any query that reaches it. This backs the pack's "no resident PII"
--     claim: the controls reconcile money by ledger, property and lease ID only.

PRAGMA foreign_keys = ON;

-- The broker's own book of every movement of beneficiary money in and out of the
-- pooled trust account. Each entry is tagged to a beneficiary ledger (ledger_id)
-- of one of two kinds: an OWNER ledger (money held for a property owner) or a
-- DEPOSIT ledger (a tenant security deposit for one lease). A ledger's balance is
-- the running signed total of its entries: an IN entry adds, an OUT entry
-- subtracts. The broker's total trust liability is the sum of all ledger
-- balances, and it must never exceed what the bank actually holds.
CREATE TABLE trust_ledger (
  entry_id    TEXT PRIMARY KEY,
  ledger_id   TEXT NOT NULL,                                  -- the beneficiary ledger (e.g. OWNER-100, DEP-L-001)
  ledger_type TEXT NOT NULL CHECK (ledger_type IN ('OWNER', 'DEPOSIT')),
  property_id TEXT NOT NULL,                                  -- the property the money relates to
  lease_id    TEXT,                                           -- the lease for a DEPOSIT ledger; NULL for OWNER funds
  entry_type  TEXT NOT NULL CHECK (entry_type IN ('IN', 'OUT')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),    -- always positive; entry_type gives the sign
  entry_date  TEXT NOT NULL
);

-- Point-in-time bank reconciliations of the trust account. The reconciled bank
-- balance is statement + deposits in transit − outstanding checks; the
-- trust-vs-liability control reads the most recent one on or before its date.
CREATE TABLE trust_bank_snapshots (
  snapshot_id                  TEXT PRIMARY KEY,
  snapshot_date                TEXT NOT NULL,
  bank_statement_balance_cents INTEGER NOT NULL,
  deposits_in_transit_cents    INTEGER NOT NULL,
  outstanding_checks_cents     INTEGER NOT NULL
);

-- The leases the brokerage manages. security_deposit_cents is the deposit the
-- tenant paid, which must be held in the trust account for the life of the
-- lease. An ENDED lease records the move-out date; deposit_returned_date is set
-- once the deposit is returned (or disposed of), and a null past the state's
-- deadline is a late return.
CREATE TABLE leases (
  lease_id             TEXT PRIMARY KEY,
  property_id          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
  security_deposit_cents INTEGER NOT NULL CHECK (security_deposit_cents >= 0),
  start_date           TEXT NOT NULL,
  move_out_date        TEXT,                                  -- set when the lease has ENDED
  deposit_returned_date TEXT                                  -- set once the deposit is returned
);

-- Not allow-listed: present so the guard has something to refuse. Holds the
-- tenant and owner PII (names, SSNs, bank account numbers) the pack promises
-- never to read; the trust controls work from ledger, property and lease IDs.
CREATE TABLE resident_pii (
  party_id       TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,   -- sensitive: not allow-listed
  ssn            TEXT,            -- sensitive: not allow-listed
  bank_account   TEXT,            -- sensitive: not allow-listed
  email          TEXT             -- sensitive: not allow-listed
);

-- ── trust ledger ─────────────────────────────────────────────────────────────
-- Five beneficiary ledgers. Signed balance per entry_type: IN adds, OUT subtracts.
--   OWNER-100 (property P-1): 300,000 − 250,000 =  50,000
--   OWNER-200 (property P-2): 200,000 − 150,000 =  50,000
--   DEP-L-001 (lease L-001):  120,000           = 120,000  (tenant deposit, held)
--   DEP-L-002 (lease L-002):  100,000           = 100,000  (tenant deposit, held)
--   DEP-L-003 (lease L-003):   90,000 −  90,000 =       0  (deposit returned at move-out)
--   Total trust liability:                        320,000
INSERT INTO trust_ledger (entry_id, ledger_id, ledger_type, property_id, lease_id, entry_type, amount_cents, entry_date) VALUES
  -- owner funds (rent collected, then disbursed to the owner)
  ('L-0001', 'OWNER-100', 'OWNER',   'P-1', NULL,    'IN',  300000, '2026-06-01'),
  ('L-0002', 'OWNER-100', 'OWNER',   'P-1', NULL,    'OUT', 250000, '2026-06-10'),
  ('L-0003', 'OWNER-200', 'OWNER',   'P-2', NULL,    'IN',  200000, '2026-06-02'),
  ('L-0004', 'OWNER-200', 'OWNER',   'P-2', NULL,    'OUT', 150000, '2026-06-11'),
  -- tenant security deposits (held in trust for the life of the lease)
  ('L-0010', 'DEP-L-001', 'DEPOSIT', 'P-1', 'L-001', 'IN',  120000, '2026-01-15'),
  ('L-0011', 'DEP-L-002', 'DEPOSIT', 'P-2', 'L-002', 'IN',  100000, '2026-02-01'),
  -- an ended lease whose deposit was returned at move-out
  ('L-0020', 'DEP-L-003', 'DEPOSIT', 'P-3', 'L-003', 'IN',   90000, '2025-11-01'),
  ('L-0021', 'DEP-L-003', 'DEPOSIT', 'P-3', 'L-003', 'OUT',  90000, '2026-05-20');

-- ── bank snapshots ───────────────────────────────────────────────────────────
-- The later snapshot (2026-06-30) is the one the reconciliation reads; the
-- earlier one proves it takes the most recent by date. On the latest snapshot the
-- bank statement (340,000) has not yet cleared a 20,000 outstanding check, so
-- the reconciled balance = 340,000 + 0 − 20,000 = 320,000, the trust liability.
INSERT INTO trust_bank_snapshots (snapshot_id, snapshot_date, bank_statement_balance_cents, deposits_in_transit_cents, outstanding_checks_cents) VALUES
  ('S-01', '2026-03-31', 210000, 0,     0),
  ('S-02', '2026-06-30', 340000, 0, 20000);

-- ── leases ───────────────────────────────────────────────────────────────────
-- Two active leases whose deposits are fully held, and one ended lease whose
-- deposit was returned on 2026-05-20 (well inside Florida's deadline after the
-- 2026-05-01 move-out), so nothing is overdue on the clean seed.
INSERT INTO leases (lease_id, property_id, status, security_deposit_cents, start_date, move_out_date, deposit_returned_date) VALUES
  ('L-001', 'P-1', 'ACTIVE', 120000, '2026-01-15', NULL,         NULL),
  ('L-002', 'P-2', 'ACTIVE', 100000, '2026-02-01', NULL,         NULL),
  ('L-003', 'P-3', 'ENDED',   90000, '2025-11-01', '2026-05-01', '2026-05-20');

-- ── resident PII (NOT allow-listed) ──────────────────────────────────────────
INSERT INTO resident_pii (party_id, full_name, ssn, bank_account, email) VALUES
  ('OWNER-100', 'Diane Castellano', '265-55-0101', '1234567890', 'dcastellano@example.com'),
  ('OWNER-200', 'Reef Holdings LLC', NULL,         '0987654321', 'ops@reef.example'),
  ('TEN-001',   'Marcus Bell',      '265-55-0202', '5551234567', 'mbell@example.com');

-- Northfield Law Group, LLC (FICTIONAL) client trust account (IOLTA) ledger.
--
-- Synthetic demo data for the civic-chain-auditor skill's Law Firm Trust (IOLTA)
-- pack. Every name, matter, figure and contact here is invented; Northfield is
-- not a real firm. All money is INTEGER CENTS.
--
-- A lawyer's client trust account is pooled client money the firm holds but does
-- not own. ABA Model Rule 1.15 and every state's analogue require it be kept
-- separate from firm funds and reconciled on a schedule (a monthly three-way
-- reconciliation in many states). The five controls encode that discipline.
--
-- The data is deliberately CLEAN so all five IOLTA controls read PASS out of the
-- box, the same way the municipal and insurance demos keep their default seeds
-- clean:
--   * three-way-reconciliation: adjusted bank (620,000 statement − 50,000
--     outstanding checks = 570,000) equals the trust journal balance (570,000)
--     equals the sum of the client ledgers (570,000). All three tie.
--   * negative-client-balances: no client ledger is overdrawn, so no client's
--     money is funding another's disbursement.
--   * unsupported-fee-transfers: every earned-fee transfer out of trust cites a
--     fee invoice and is no larger than it.
--   * firm-funds-in-trust: the firm holds only a 20,000 buffer for bank
--     charges, under the 25,000 default allowance, so there is no commingling.
--   * dormant-balances: at the 365-day default no positive balance is idle long
--     enough to need client contact; the Chen matter (idle ~146 days) surfaces
--     only at a tighter threshold.
--
-- Two details exist so the engine's safeguards are visible on the demo data:
--   * client_contacts is deliberately NOT in sample_iolta_allowlist.json (it
--     holds client names, emails and addresses), so the guard refuses any query
--     that reaches it; this is what backs the pack's "no client PII" claim. The
--     ledger carries only client and matter IDs.
--   * trust_journal carries one OUTSTANDING disbursement (a check not yet
--     cleared at the bank); the bank statement has not deducted it, which is
--     exactly why the three-way reconciliation subtracts outstanding checks.

PRAGMA foreign_keys = ON;

-- The trust journal: the firm's own book (checkbook) record of every movement
-- of client money in and out of the pooled trust account. The journal balance
-- is the running signed total of these entries. Each is tagged to a client
-- ledger (client_id); FIRM-BUFFER is the firm's own ledger card for the small
-- balance a bank allows to cover service charges.
CREATE TABLE trust_journal (
  entry_id       TEXT PRIMARY KEY,
  client_id      TEXT,                                  -- the client ledger; NULL = an unidentified deposit (a finding)
  matter_id      TEXT,                                  -- the matter the money belongs to; NULL for the firm buffer
  entry_type     TEXT NOT NULL CHECK (entry_type IN ('CLIENT_DEPOSIT', 'CLIENT_DISBURSEMENT', 'EARNED_FEE_TRANSFER', 'FIRM_BUFFER_IN')),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),  -- always positive; entry_type gives the sign
  invoice_id     TEXT,                                  -- required for EARNED_FEE_TRANSFER; the invoice it draws against
  cleared_status TEXT NOT NULL CHECK (cleared_status IN ('CLEARED', 'OUTSTANDING')),
  entry_date     TEXT NOT NULL
);

-- Point-in-time bank reconciliations of the trust account. The adjusted bank
-- balance is statement + deposits in transit − outstanding checks; the
-- three-way control reads the most recent one.
CREATE TABLE trust_bank_snapshots (
  snapshot_id                 TEXT PRIMARY KEY,
  snapshot_date               TEXT NOT NULL,
  bank_statement_balance_cents INTEGER NOT NULL,
  deposits_in_transit_cents    INTEGER NOT NULL,
  outstanding_checks_cents     INTEGER NOT NULL
);

-- Fee invoices the firm has billed. An earned-fee transfer out of trust is
-- supported only when it cites one of these and does not exceed it.
CREATE TABLE fee_invoices (
  invoice_id          TEXT PRIMARY KEY,
  client_id           TEXT NOT NULL,
  matter_id           TEXT NOT NULL,
  invoice_amount_cents INTEGER NOT NULL,
  invoice_date        TEXT NOT NULL
);

-- Not allow-listed: present so the guard has something to refuse. Holds the
-- client PII (names, contact, addresses) the pack promises never to read.
CREATE TABLE client_contacts (
  client_id      TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,   -- sensitive: not allow-listed
  email          TEXT,            -- sensitive: not allow-listed
  phone          TEXT,            -- sensitive: not allow-listed
  street_address TEXT             -- sensitive: not allow-listed
);

-- ── fee invoices ─────────────────────────────────────────────────────────────
-- One invoice behind each earned-fee transfer, each at least as large as the
-- transfer it supports (INV-1 is exactly the transfer; INV-2 is larger).
INSERT INTO fee_invoices (invoice_id, client_id, matter_id, invoice_amount_cents, invoice_date) VALUES
  ('INV-1', 'C-100', 'M-100A', 100000, '2026-04-18'),
  ('INV-2', 'C-200', 'M-200A',  60000, '2026-06-12');

-- ── trust journal ────────────────────────────────────────────────────────────
-- Three client ledgers plus the firm buffer. Signed balance per entry_type:
-- CLIENT_DEPOSIT and FIRM_BUFFER_IN add; CLIENT_DISBURSEMENT and
-- EARNED_FEE_TRANSFER subtract.
--
--   C-100 (Alvarez matter): 500,000 − 200,000 − 100,000 = 200,000
--   C-200 (Bryce matter):   300,000 −  50,000           = 250,000
--   C-300 (Chen matter):    150,000 −  50,000           = 100,000  (idle since 2026-01-20)
--   FIRM-BUFFER:             20,000                      =  20,000
--   Journal total:                                        570,000
INSERT INTO trust_journal (entry_id, client_id, matter_id, entry_type, amount_cents, invoice_id, cleared_status, entry_date) VALUES
  -- C-100
  ('T-0001', 'C-100', 'M-100A', 'CLIENT_DEPOSIT',      500000, NULL,    'CLEARED',     '2026-02-10'),
  ('T-0002', 'C-100', 'M-100A', 'CLIENT_DISBURSEMENT', 200000, NULL,    'CLEARED',     '2026-03-05'),
  ('T-0003', 'C-100', 'M-100A', 'EARNED_FEE_TRANSFER', 100000, 'INV-1', 'CLEARED',     '2026-04-20'),
  -- C-200
  ('T-0010', 'C-200', 'M-200A', 'CLIENT_DEPOSIT',      300000, NULL,    'CLEARED',     '2026-05-01'),
  ('T-0011', 'C-200', 'M-200A', 'EARNED_FEE_TRANSFER',  50000, 'INV-2', 'CLEARED',     '2026-06-15'),
  -- C-300 (the court-filing disbursement is still OUTSTANDING at the bank)
  ('T-0020', 'C-300', 'M-300A', 'CLIENT_DEPOSIT',      150000, NULL,    'CLEARED',     '2026-01-08'),
  ('T-0021', 'C-300', 'M-300A', 'CLIENT_DISBURSEMENT',  50000, NULL,    'OUTSTANDING', '2026-01-20'),
  -- Firm buffer for bank charges (the firm's own ledger card)
  ('T-0030', 'FIRM-BUFFER', NULL, 'FIRM_BUFFER_IN',     20000, NULL,    'CLEARED',     '2026-02-01');

-- ── bank snapshots ───────────────────────────────────────────────────────────
-- The later snapshot (2026-06-30) is the one the reconciliation reads; the
-- earlier one proves it takes the most recent by date. On the latest snapshot
-- the bank statement (620,000) has not yet cleared the 50,000 outstanding
-- check, so adjusted bank = 620,000 + 0 − 50,000 = 570,000, the journal balance.
INSERT INTO trust_bank_snapshots (snapshot_id, snapshot_date, bank_statement_balance_cents, deposits_in_transit_cents, outstanding_checks_cents) VALUES
  ('S-01', '2026-01-31', 160000, 0,     0),
  ('S-02', '2026-06-30', 620000, 0, 50000);

-- ── client contacts (NOT allow-listed) ───────────────────────────────────────
INSERT INTO client_contacts (client_id, full_name, email, phone, street_address) VALUES
  ('C-100', 'Marisol Alvarez',  'malvarez@example.com', '207-555-0101', '14 Harbor St, Northfield'),
  ('C-200', 'Bryce Holdings LLC','ops@bryce.example',    '207-555-0102', '9 Mill Rd, Northfield'),
  ('C-300', 'Estate of R. Chen','executor@example.com',  '207-555-0103', '22 Elm Ave, Northfield');

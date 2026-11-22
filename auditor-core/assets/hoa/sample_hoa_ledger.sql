-- Palm Grove Community Association, Inc. (FICTIONAL) HOA operating and reserve books.
--
-- Synthetic demo data for the civic-chain-auditor skill's Property Management &
-- HOA pack (the HOA board-review ruleset, hoa-v1). Every name, unit, figure and
-- transfer here is invented; Palm Grove is not a real association. All money is
-- INTEGER CENTS.
--
-- A California HOA board must review, monthly, the operating and reserve account
-- reconciliations, the budget against actual spending, and the delinquent
-- assessments (Civil Code s 5500). Money moved out of the reserve account needs
-- prior written board approval (s 5502). The three controls check those three
-- board-review duties: reserve money moved without approval on record, operating
-- lines spent over budget, and owner assessments past the aging threshold.
--
-- The data is deliberately CLEAN so all three HOA controls read PASS out of the
-- box, the same way the municipal, insurance, IOLTA, excise and property demos
-- keep their default seeds clean:
--   * reserve-transfers-unapproved: every transfer OUT of the reserve account
--     cites the board minutes that approved it; a contribution INTO reserve needs
--     no approval, so RT-2 (operating to reserve, no approval) is not a finding.
--   * budget-variance: every operating line's spending is within its adopted
--     budget for FY 2026 (Insurance is exactly at budget, which still passes).
--   * delinquent-assessments: at the 60-day default no unpaid assessment is aged
--     past the threshold; the unit U-103 assessment (17 days past due) surfaces
--     only at a tighter threshold.
--
-- One detail exists so the engine's safeguard is visible on the demo data:
--   * resident_pii is deliberately NOT in sample_hoa_allowlist.json (it holds
--     unit-owner names, emails and phone numbers), so the guard refuses any query
--     that reaches it. This backs the pack's "no resident PII" claim: the
--     controls work from unit, line and transfer IDs only.

PRAGMA foreign_keys = ON;

-- Money moved between the association's operating and reserve accounts. A
-- transfer OUT of the reserve account needs prior written board approval on
-- record (Civil Code s 5502); board_approval_id is the minutes reference that
-- authorized it. A transfer INTO reserve (a funding contribution) needs none.
CREATE TABLE reserve_transfers (
  transfer_id      TEXT PRIMARY KEY,
  transfer_date    TEXT NOT NULL,
  from_account     TEXT NOT NULL CHECK (from_account IN ('OPERATING', 'RESERVE')),
  to_account       TEXT NOT NULL CHECK (to_account IN ('OPERATING', 'RESERVE')),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  board_approval_id TEXT,                                 -- minutes reference; required for a transfer OUT of reserve
  approval_date    TEXT
);

-- The adopted operating budget, one row per line per fiscal year. Actual
-- spending comes from operating_expenses; a line spent over its adopted budget
-- is an overspend the board must see.
CREATE TABLE budget_lines (
  line_id      TEXT PRIMARY KEY,
  fiscal_year  INTEGER NOT NULL,
  category     TEXT NOT NULL,
  adopted_cents INTEGER NOT NULL CHECK (adopted_cents >= 0)
);

-- Operating-account expenses, each charged to a budget line.
CREATE TABLE operating_expenses (
  expense_id   TEXT PRIMARY KEY,
  line_id      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  expense_date TEXT NOT NULL
);

-- Owner assessments (HOA dues), one row per unit per billing period. paid_date
-- is set once the owner pays; a null paid_date aged past the threshold is a
-- delinquent assessment the board must track.
CREATE TABLE assessments (
  assessment_id TEXT PRIMARY KEY,
  unit_id      TEXT NOT NULL,
  due_date     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  paid_date    TEXT
);

-- Not allow-listed: present so the guard has something to refuse. Holds the
-- unit-owner PII (names, emails, phone numbers) the pack promises never to read;
-- the controls work from unit, line and transfer IDs only.
CREATE TABLE resident_pii (
  unit_id    TEXT PRIMARY KEY,
  full_name  TEXT NOT NULL,   -- sensitive: not allow-listed
  email      TEXT,            -- sensitive: not allow-listed
  phone      TEXT             -- sensitive: not allow-listed
);

-- ── reserve transfers ────────────────────────────────────────────────────────
-- RT-1 moves reserve money out for a roof repair and cites the approving minutes.
-- RT-2 is a contribution INTO reserve from operating, which needs no approval, so
-- its null board_approval_id is correct and not a finding.
INSERT INTO reserve_transfers (transfer_id, transfer_date, from_account, to_account, amount_cents, board_approval_id, approval_date) VALUES
  ('RT-1', '2026-02-15', 'RESERVE',   'OPERATING', 200000, 'MIN-2026-02', '2026-02-10'),
  ('RT-2', '2026-04-10', 'OPERATING', 'RESERVE',   100000, NULL,          NULL);

-- ── budget lines (FY 2026) ───────────────────────────────────────────────────
INSERT INTO budget_lines (line_id, fiscal_year, category, adopted_cents) VALUES
  ('BL-1', 2026, 'Landscaping', 500000),
  ('BL-2', 2026, 'Insurance',   800000),
  ('BL-3', 2026, 'Utilities',   300000);

-- ── operating expenses ───────────────────────────────────────────────────────
-- Every line is within its adopted budget: Landscaping 450,000 of 500,000,
-- Insurance 800,000 of 800,000 (exactly at budget), Utilities 250,000 of 300,000.
INSERT INTO operating_expenses (expense_id, line_id, amount_cents, expense_date) VALUES
  ('E-01', 'BL-1', 250000, '2026-01-20'),
  ('E-02', 'BL-1', 200000, '2026-04-18'),
  ('E-03', 'BL-2', 800000, '2026-01-05'),
  ('E-04', 'BL-3', 150000, '2026-02-28'),
  ('E-05', 'BL-3', 100000, '2026-05-12');

-- ── assessments ──────────────────────────────────────────────────────────────
-- Two paid on time, and two unpaid. The latest due date (2026-06-01) is the
-- clock for aging: the U-103 assessment (due 2026-05-15) is 17 days past due, and
-- the U-101 June assessment is 0 days past due, so neither is aged past the
-- 60-day default. A tighter days_past_due surfaces the U-103 one.
INSERT INTO assessments (assessment_id, unit_id, due_date, amount_cents, paid_date) VALUES
  ('A-1', 'U-101', '2026-03-01', 120000, '2026-03-05'),
  ('A-2', 'U-102', '2026-04-01', 120000, '2026-04-02'),
  ('A-3', 'U-103', '2026-05-15', 120000, NULL),
  ('A-4', 'U-101', '2026-06-01', 120000, NULL);

-- ── resident PII (NOT allow-listed) ──────────────────────────────────────────
INSERT INTO resident_pii (unit_id, full_name, email, phone) VALUES
  ('U-101', 'Harold Nguyen',  'hnguyen@example.com', '805-555-0101'),
  ('U-102', 'Priya Raman',    'praman@example.com',  '805-555-0102'),
  ('U-103', 'Garden Trust LP', 'ops@gardentrust.example', '805-555-0103');

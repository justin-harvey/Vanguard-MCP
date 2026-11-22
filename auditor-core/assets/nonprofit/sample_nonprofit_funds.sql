-- Merrymeeting Bay Community Services, Inc. (FICTIONAL) nonprofit fund accounting.
--
-- Synthetic demo data for the civic-chain-auditor skill's Nonprofit Restricted
-- Funds pack. Every name, fund, grant and figure here is invented; Merrymeeting
-- Bay Community Services is not a real organization. All money is INTEGER CENTS.
--
-- A nonprofit that accepts donor-restricted gifts and federal awards must track
-- two things the engine reconciles here: the donor restriction on each fund
-- (ASC 958, as amended by ASU 2016-14: net assets are reported with or without
-- donor restrictions, a met restriction is released from restriction, and every
-- expense is analyzed by both nature and function) and whether its federal
-- spending reaches the Single Audit trigger (2 CFR 200.501: an entity that
-- spends $1,000,000 or more in federal awards in its fiscal year needs a Single
-- Audit; the threshold was raised from $750,000 for fiscal years beginning on or
-- after October 1, 2024). The five controls produce the same evidence an auditor
-- under Uniform Guidance builds a finding from.
--
-- The threshold is DATA, not code: single-audit-threshold takes threshold_cents
-- as a parameter defaulting to 100,000,000 cents ($1,000,000), so the next OMB
-- change is a parameter or ruleset version bump, never new SQL.
--
-- The data is deliberately CLEAN so all five Nonprofit controls read PASS out of
-- the box, the same way the municipal, insurance, IOLTA, excise and property/HOA
-- demos keep their default seeds clean:
--   * restricted-spending: every expense charged to a restricted fund is for
--     that fund's purpose (program_code = the fund's purpose_code) and falls
--     inside the fund's time window, so no restricted dollar is misspent.
--   * releases-vs-spending: the amount released from each restricted fund is at
--     or below the qualifying spending that justified the release, so no
--     restriction was released before the money was used.
--       FND-SCHOL: released 6,000,000 <= qualifying 6,500,000 (EXP-1 + EXP-2).
--       FND-BLDG:  released 7,500,000 <= qualifying 8,000,000 (EXP-3).
--   * functional-expense-tie: the nature x function grid of every expense sums
--     to total expenses (20,200,000) and carries no negative cell, so the
--     statement of functional expenses ties.
--   * restricted-cash-coverage: cash and investments on hand (25,000,000) are at
--     least net assets with donor restrictions (20,000,000), so restricted money
--     was not spent down into operations.
--   * single-audit-threshold: federal awards expended in the year (75,000,000 =
--     $750,000) are below the $1,000,000 Single Audit trigger; the year surfaces
--     only at a lower threshold_cents.
--
-- One detail exists so the engine's safeguard is visible on the demo data:
--   * donor_pii is deliberately NOT in sample_nonprofit_allowlist.json (it holds
--     donor names, addresses and individual gift histories), so the guard
--     refuses any query that reaches it. This backs the pack's "no donor data"
--     claim: the controls reconcile funds, releases and expenses by fund, line
--     and program code only.

PRAGMA foreign_keys = ON;

-- The funds the organization accounts for. restriction_class is the donor
-- restriction on the fund: RESTRICTED funds may be spent only for purpose_code
-- and only inside [window_start, window_end]; an UNRESTRICTED fund carries the
-- sentinel purpose_code 'GENERAL' and an open window, and the restricted-spending
-- control ignores it. purpose_code is matched against an expense's program_code.
CREATE TABLE funds (
  fund_id          TEXT PRIMARY KEY,
  fund_name        TEXT NOT NULL,
  restriction_class TEXT NOT NULL,          -- RESTRICTED | UNRESTRICTED
  purpose_code     TEXT NOT NULL,           -- the program a restricted fund may pay for
  window_start     TEXT NOT NULL,           -- YYYY-MM-DD; restricted spending allowed from this date
  window_end       TEXT NOT NULL            -- YYYY-MM-DD; restricted spending allowed through this date
);

-- Every expense, tagged with the fund it was charged to, the program it paid
-- for (program_code, matched against a restricted fund's purpose_code), and its
-- natural and functional classification for the ASC 958 functional-expense grid.
-- amount_cents is not constrained non-negative: a reversal or credit can be
-- negative, which the functional-expense-tie control reports as a negative cell.
CREATE TABLE expenses (
  expense_id    TEXT PRIMARY KEY,
  fiscal_year   INTEGER NOT NULL,
  fund_id       TEXT NOT NULL,
  program_code  TEXT NOT NULL,              -- what the spend was for
  nature_code   TEXT NOT NULL,              -- natural classification: SALARIES, GRANTS, OCCUPANCY, SUPPLIES
  function_class TEXT NOT NULL,             -- functional classification: PROGRAM, MGMT_GENERAL, FUNDRAISING
  amount_cents  INTEGER NOT NULL,
  expense_date  TEXT NOT NULL               -- YYYY-MM-DD
);

-- Amounts released from donor restriction in a fiscal year, by fund. A release
-- is reported when a restriction is met; the released amount must not exceed the
-- qualifying spending (spending for the fund's purpose, inside its window) that
-- justified it.
CREATE TABLE restriction_releases (
  release_id    TEXT PRIMARY KEY,
  fund_id       TEXT NOT NULL,
  fiscal_year   INTEGER NOT NULL,
  released_cents INTEGER NOT NULL CHECK (released_cents >= 0),
  release_date  TEXT NOT NULL
);

-- Point-in-time balance-sheet balances by account type, for the liquidity check.
-- CASH and INVESTMENT balances are the liquid assets that must cover net assets
-- with donor restrictions; OTHER (receivables, fixed assets) is not liquid.
CREATE TABLE account_balances (
  balance_id    TEXT PRIMARY KEY,
  account_type  TEXT NOT NULL,              -- CASH | INVESTMENT | OTHER
  balance_cents INTEGER NOT NULL,
  as_of         TEXT NOT NULL               -- YYYY-MM-DD snapshot date
);

-- Net asset balances by donor-restriction class (ASC 958's two classes), as of a
-- snapshot date. restricted-cash-coverage compares liquid assets against the
-- WITH_DONOR_RESTRICTIONS balance.
CREATE TABLE net_assets (
  na_id            TEXT PRIMARY KEY,
  restriction_class TEXT NOT NULL,          -- WITH_DONOR_RESTRICTIONS | WITHOUT_DONOR_RESTRICTIONS
  balance_cents    INTEGER NOT NULL,
  as_of            TEXT NOT NULL            -- YYYY-MM-DD snapshot date
);

-- Federal award spending by program, for the Single Audit threshold test. The
-- sum of expended_cents in a fiscal year is compared against the trigger.
CREATE TABLE federal_awards (
  award_id      TEXT PRIMARY KEY,
  fiscal_year   INTEGER NOT NULL,
  program_name  TEXT NOT NULL,
  cfda_number   TEXT NOT NULL,              -- Assistance Listing (CFDA) number
  expended_cents INTEGER NOT NULL CHECK (expended_cents >= 0)
);

-- Not allow-listed: present so the guard has something to refuse. Holds the
-- donor names, addresses and individual gift histories the pack promises never
-- to read. The controls work from fund, line and program codes only.
CREATE TABLE donor_pii (
  donor_id       TEXT PRIMARY KEY,
  donor_name     TEXT NOT NULL,   -- sensitive: not allow-listed
  street_address TEXT,            -- sensitive: not allow-listed
  gift_history   TEXT             -- sensitive: not allow-listed
);

-- ── funds ────────────────────────────────────────────────────────────────────
-- One unrestricted operating fund and two donor-restricted funds: a scholarship
-- fund restricted to the 2026 calendar year, and a multi-year capital campaign.
INSERT INTO funds (fund_id, fund_name, restriction_class, purpose_code, window_start, window_end) VALUES
  ('FND-GEN',   'General Operating Fund', 'UNRESTRICTED', 'GENERAL',     '0001-01-01', '9999-12-31'),
  ('FND-SCHOL', 'Scholarship Fund',       'RESTRICTED',   'SCHOLARSHIP', '2026-01-01', '2026-12-31'),
  ('FND-BLDG',  'Building Campaign Fund', 'RESTRICTED',   'CAPITAL',     '2025-07-01', '2027-06-30');

-- ── expenses ─────────────────────────────────────────────────────────────────
-- Restricted-fund spending (EXP-1..EXP-3) is all for the fund's purpose and
-- inside its window. General-fund spending (EXP-4..EXP-7) carries the management,
-- fundraising and program functional classes. The nature x function grid:
--   GRANTS/PROGRAM        5,000,000     SALARIES/MGMT_GENERAL 3,000,000
--   SALARIES/PROGRAM      1,500,000     SALARIES/FUNDRAISING  1,000,000
--   OCCUPANCY/PROGRAM     8,000,000     SUPPLIES/PROGRAM        500,000
--   OCCUPANCY/MGMT_GENERAL 1,200,000
-- summing to 20,200,000 cents ($202,000), with no negative cell.
INSERT INTO expenses (expense_id, fiscal_year, fund_id, program_code, nature_code, function_class, amount_cents, expense_date) VALUES
  ('EXP-1', 2026, 'FND-SCHOL', 'SCHOLARSHIP', 'GRANTS',    'PROGRAM',       5000000, '2026-03-15'),
  ('EXP-2', 2026, 'FND-SCHOL', 'SCHOLARSHIP', 'SALARIES',  'PROGRAM',       1500000, '2026-04-01'),
  ('EXP-3', 2026, 'FND-BLDG',  'CAPITAL',     'OCCUPANCY', 'PROGRAM',       8000000, '2026-05-20'),
  ('EXP-4', 2026, 'FND-GEN',   'GENERAL',     'SALARIES',  'MGMT_GENERAL',  3000000, '2026-02-10'),
  ('EXP-5', 2026, 'FND-GEN',   'GENERAL',     'SALARIES',  'FUNDRAISING',   1000000, '2026-06-15'),
  ('EXP-6', 2026, 'FND-GEN',   'GENERAL',     'SUPPLIES',  'PROGRAM',        500000, '2026-07-01'),
  ('EXP-7', 2026, 'FND-GEN',   'GENERAL',     'OCCUPANCY', 'MGMT_GENERAL',  1200000, '2026-08-01');

-- ── restriction releases ─────────────────────────────────────────────────────
-- Each release is at or below the qualifying spending that justified it.
INSERT INTO restriction_releases (release_id, fund_id, fiscal_year, released_cents, release_date) VALUES
  ('REL-1', 'FND-SCHOL', 2026, 6000000, '2026-12-31'),
  ('REL-2', 'FND-BLDG',  2026, 7500000, '2026-12-31');

-- ── balance-sheet snapshot (as of 2026-12-31) ────────────────────────────────
-- Liquid assets (CASH + INVESTMENT) total 25,000,000; OTHER is not liquid.
INSERT INTO account_balances (balance_id, account_type, balance_cents, as_of) VALUES
  ('AB-1', 'CASH',       15000000, '2026-12-31'),
  ('AB-2', 'INVESTMENT', 10000000, '2026-12-31'),
  ('AB-3', 'OTHER',       2000000, '2026-12-31');

-- Net assets with donor restrictions (20,000,000) are covered by the 25,000,000
-- of liquid assets above.
INSERT INTO net_assets (na_id, restriction_class, balance_cents, as_of) VALUES
  ('NA-1', 'WITH_DONOR_RESTRICTIONS',    20000000, '2026-12-31'),
  ('NA-2', 'WITHOUT_DONOR_RESTRICTIONS',  8000000, '2026-12-31');

-- ── federal awards (FY2026) ──────────────────────────────────────────────────
-- Total expended 75,000,000 = $750,000, below the $1,000,000 Single Audit
-- trigger. The year surfaces only when threshold_cents is lowered.
INSERT INTO federal_awards (award_id, fiscal_year, program_name, cfda_number, expended_cents) VALUES
  ('FA-1', 2026, 'Community Services Block Grant', '93.569', 45000000),
  ('FA-2', 2026, 'Emergency Food Assistance',      '10.569', 30000000);

-- ── donor PII (NOT allow-listed) ─────────────────────────────────────────────
INSERT INTO donor_pii (donor_id, donor_name, street_address, gift_history) VALUES
  ('D-100', 'Eleanor Whitfield', '8 Harpswell Rd, Brunswick, ME', '2024:5000;2025:7500'),
  ('D-200', 'Thomas Ashby',      '21 Bay St, Bath, ME',           '2025:10000');

-- Kennebec Valley Regional School Unit (FICTIONAL) school-district ledger.
--
-- Synthetic demo data for the civic-chain-auditor skill's School Districts pack.
-- Every name, account, grant and figure here is invented; Kennebec Valley
-- Regional School Unit is not a real district. All money is INTEGER CENTS.
--
-- A school district's weakest controls are usually in two places: the student
-- activity funds (club and class accounts the district holds in a custodial
-- capacity) and federal program money. The five controls reconcile both:
--   * student activity funds. GASB Statement No. 84 decides whether student
--     activity money is a fiduciary (custodial) fund the district holds for the
--     students, or a governmental fund of the district; the test is who controls
--     the assets and whether the district has administrative involvement. School
--     districts applied GASB 84 for fiscal years ending June 30, 2020. The demo
--     treats the activity accounts as CUSTODIAL funds and reconciles them for
--     overdrafts, late deposits (the classic cash-loss point) and disbursements
--     missing the required advisor-plus-principal approval.
--   * federal program money follows 2 CFR 200: a cost must fall inside the
--     award's period of performance (2 CFR 200.403, 200.309). The demo flags a
--     federal cost charged before or after its program's period.
--   * budget variance reuses the municipal budget-versus-actual pattern against
--     the district's adopted and amended budget lines.
--
-- The chart of accounts follows the Fund / Function / Object structure of the
-- Maine DOE School Finance accounting handbook
-- (https://www.maine.gov/doe/funding/accounting/handbook); the specific codes
-- and dollar amounts are modeled for the demo.
--
-- Approval and deposit rules are DATA or PARAMETERS, not code:
--   * activity-deposits-late takes deposit_days as a parameter defaulting to 1
--     (student-activity manuals commonly require a deposit within one business
--     day of collection), so a district with a different policy passes its own
--     number rather than editing the ruleset.
--   * the approval rule (advisor AND principal) is encoded in the advisor_approved
--     and principal_approved flags on each disbursement, read from the ledger.
--
-- The data is deliberately CLEAN so all five School controls read PASS out of
-- the box, the same way the municipal, insurance, IOLTA, excise, property/HOA
-- and nonprofit demos keep their default seeds clean:
--   * activity-negative-balances: every activity account's collections exceed its
--     disbursements, so no club spends money it does not have.
--   * activity-deposits-late: every collection is deposited the day it is
--     collected (zero days), inside the default one-day window.
--   * activity-unapproved-disbursements: every disbursement carries both the
--     advisor and the principal approval.
--   * federal-outside-period: every federal cost is charged inside its program's
--     period of performance.
--   * budget-variance: every budget line's paid spending is within its amended
--     budget, and the paid total ties.
--
-- One detail exists so the engine's safeguard is visible on the demo data:
--   * student_records is deliberately NOT in sample_schools_allowlist.json (it
--     holds student names, grade levels and meal-eligibility status, all
--     protected under FERPA), so the guard refuses any query that reaches it.
--     This backs the pack's "no student data" claim: the controls reconcile
--     activity accounts, federal costs and budget lines by code only.

PRAGMA foreign_keys = ON;

-- The student activity accounts the district holds. Under GASB 84 these are
-- CUSTODIAL (fiduciary) funds: the district holds the money for the student
-- groups, it does not own it. activity_type is the kind of group (CLUB, CLASS,
-- ATHLETIC). An account's balance is its collections less its disbursements.
CREATE TABLE activity_accounts (
  account_id    TEXT PRIMARY KEY,
  account_name  TEXT NOT NULL,
  activity_type TEXT NOT NULL,              -- CLUB | CLASS | ATHLETIC
  fund_class    TEXT NOT NULL               -- CUSTODIAL (GASB 84 fiduciary fund)
);

-- Cash collected into an activity account. collected_date is when the money was
-- taken in; deposited_date is when it reached the bank (NULL means it has not
-- been deposited). The gap between the two is the exposure the late-deposit
-- control measures; undeposited cash is the classic activity-fund loss point.
CREATE TABLE activity_collections (
  collection_id  TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  fiscal_year    INTEGER NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
  collected_date TEXT NOT NULL,             -- YYYY-MM-DD when the cash was taken in
  deposited_date TEXT                       -- YYYY-MM-DD when it reached the bank; NULL = not yet deposited
);

-- Money paid out of an activity account. advisor_approved and principal_approved
-- are the two required sign-offs (1 = on record, 0 = missing); a disbursement
-- needs both. amount_cents reduces the account's balance.
CREATE TABLE activity_disbursements (
  disbursement_id   TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  fiscal_year       INTEGER NOT NULL,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  disbursement_date TEXT NOT NULL,          -- YYYY-MM-DD
  advisor_approved  INTEGER NOT NULL,       -- 1 = advisor approval on record, 0 = missing
  principal_approved INTEGER NOT NULL       -- 1 = principal approval on record, 0 = missing
);

-- Federal programs the district draws on, with each award's period of
-- performance. A cost charged before period_start or after period_end is outside
-- the period (2 CFR 200.403, 200.309).
CREATE TABLE federal_programs (
  program_id   TEXT PRIMARY KEY,
  program_name TEXT NOT NULL,
  cfda_number  TEXT NOT NULL,               -- Assistance Listing (CFDA) number
  period_start TEXT NOT NULL,               -- YYYY-MM-DD period of performance start
  period_end   TEXT NOT NULL                -- YYYY-MM-DD period of performance end
);

-- Costs charged to a federal program. charge_date is tested against the
-- program's period of performance.
CREATE TABLE federal_costs (
  cost_id      TEXT PRIMARY KEY,
  program_id   TEXT NOT NULL,
  fiscal_year  INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  charge_date  TEXT NOT NULL                -- YYYY-MM-DD
);

-- The district's adopted and amended budget, by Fund / Function / Object. paid
-- spending on a line must stay within the amended budget. Modeled on the Maine
-- DOE handbook's chart-of-accounts dimensions.
CREATE TABLE budget_lines (
  line_id          TEXT PRIMARY KEY,
  fiscal_year      INTEGER NOT NULL,
  fund_code        TEXT NOT NULL,           -- e.g. 1000 General Fund
  function_code    TEXT NOT NULL,           -- e.g. 1000 Instruction, 2700 Student Transportation
  object_code      TEXT NOT NULL,           -- e.g. 0610 General Supplies
  line_description TEXT NOT NULL,
  adopted_cents    INTEGER NOT NULL,
  amended_cents    INTEGER NOT NULL
);

-- Expenditures against a budget line. status is 'paid' or 'pending'; the
-- variance control compares paid spending to the amended budget.
CREATE TABLE expenditures (
  expenditure_id TEXT PRIMARY KEY,
  line_id        TEXT NOT NULL,
  fiscal_year    INTEGER NOT NULL,
  amount_cents   INTEGER NOT NULL,
  status         TEXT NOT NULL              -- paid | pending
);

-- Not allow-listed: present so the guard has something to refuse. Holds the
-- student names, grade levels and meal-eligibility status FERPA protects. The
-- controls never read it; they work from activity-account, program and budget
-- codes only.
CREATE TABLE student_records (
  student_id        TEXT PRIMARY KEY,
  student_name      TEXT NOT NULL,   -- sensitive: not allow-listed (FERPA)
  grade_level       INTEGER,         -- sensitive: not allow-listed (FERPA)
  meal_eligibility  TEXT             -- sensitive: not allow-listed (FERPA)
);

-- ── student activity accounts (GASB 84 custodial funds) ───────────────────────
INSERT INTO activity_accounts (account_id, account_name, activity_type, fund_class) VALUES
  ('ACT-DRAMA',  'Drama Club',         'CLUB',     'CUSTODIAL'),
  ('ACT-SENIOR', 'Senior Class',       'CLASS',    'CUSTODIAL'),
  ('ACT-ATH',    'Athletics Boosters', 'ATHLETIC', 'CUSTODIAL');

-- ── activity collections (every one deposited the day it was collected) ───────
INSERT INTO activity_collections (collection_id, account_id, fiscal_year, amount_cents, collected_date, deposited_date) VALUES
  ('COL-1', 'ACT-DRAMA',  2026, 150000, '2026-03-02', '2026-03-02'),
  ('COL-2', 'ACT-SENIOR', 2026, 300000, '2026-04-10', '2026-04-10'),
  ('COL-3', 'ACT-ATH',    2026, 250000, '2026-05-05', '2026-05-05'),
  ('COL-4', 'ACT-DRAMA',  2026,  80000, '2026-06-01', '2026-06-01');

-- ── activity disbursements (each with both approvals; no account overdrawn) ───
-- Balances: DRAMA 150,000 + 80,000 - 120,000 = 110,000; SENIOR 300,000 -
-- 200,000 = 100,000; ATH 250,000 - 150,000 = 100,000. All non-negative.
INSERT INTO activity_disbursements (disbursement_id, account_id, fiscal_year, amount_cents, disbursement_date, advisor_approved, principal_approved) VALUES
  ('DIS-1', 'ACT-DRAMA',  2026, 120000, '2026-03-20', 1, 1),
  ('DIS-2', 'ACT-SENIOR', 2026, 200000, '2026-04-25', 1, 1),
  ('DIS-3', 'ACT-ATH',    2026, 150000, '2026-05-20', 1, 1);

-- ── federal programs (periods of performance) ────────────────────────────────
INSERT INTO federal_programs (program_id, program_name, cfda_number, period_start, period_end) VALUES
  ('FP-TITLE1', 'Title I-A Improving Basic Programs', '84.010', '2025-07-01', '2026-09-30'),
  ('FP-IDEA',   'IDEA Part B Grants to States',       '84.027', '2025-07-01', '2026-09-30');

-- ── federal costs (every one inside its program's period of performance) ──────
INSERT INTO federal_costs (cost_id, program_id, fiscal_year, amount_cents, charge_date) VALUES
  ('FCOST-1', 'FP-TITLE1', 2026, 500000, '2025-09-15'),
  ('FCOST-2', 'FP-TITLE1', 2026, 450000, '2026-02-10'),
  ('FCOST-3', 'FP-IDEA',   2026, 600000, '2026-03-01');

-- ── budget lines (Maine DOE Fund / Function / Object) ─────────────────────────
INSERT INTO budget_lines (line_id, fiscal_year, fund_code, function_code, object_code, line_description, adopted_cents, amended_cents) VALUES
  ('BL-INSTR', 2026, '1000', '1000', '0610', 'Instruction - General Supplies',          5000000, 5500000),
  ('BL-TRANS', 2026, '1000', '2700', '0510', 'Student Transportation - Purchased Svcs',  3000000, 3000000),
  ('BL-PLANT', 2026, '1000', '2600', '0430', 'Operation & Maintenance - Repairs',        2000000, 2200000);

-- ── expenditures (every line within its amended budget) ───────────────────────
-- Paid totals: BL-INSTR 4,800,000 <= 5,500,000; BL-TRANS 2,900,000 <= 3,000,000;
-- BL-PLANT 2,100,000 <= 2,200,000. Total paid 9,800,000.
INSERT INTO expenditures (expenditure_id, line_id, fiscal_year, amount_cents, status) VALUES
  ('EXP-1', 'BL-INSTR', 2026, 4800000, 'paid'),
  ('EXP-2', 'BL-INSTR', 2026,  200000, 'pending'),
  ('EXP-3', 'BL-TRANS', 2026, 2900000, 'paid'),
  ('EXP-4', 'BL-PLANT', 2026, 2100000, 'paid');

-- ── student records (NOT allow-listed; FERPA) ─────────────────────────────────
INSERT INTO student_records (student_id, student_name, grade_level, meal_eligibility) VALUES
  ('STU-1', 'Ava Bouchard', 11, 'FREE'),
  ('STU-2', 'Liam Caron',   12, 'REDUCED');

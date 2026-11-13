-- Town of Sampleton (FICTIONAL) budget, grant and spending ledger.
--
-- Synthetic demo data for the vanguard-mcp-auditor skill. Every name, figure,
-- vendor and tax ID here is invented; Sampleton is not a real municipality.
-- Fiscal years run July 1 to June 30 (FY2026 = 2025-07-01 .. 2026-06-30);
-- FY2027 data runs through 2026-10-31. All money is INTEGER CENTS.
--
-- Built-in findings for demos:
--   * Grant G-402 (paving): cash drawn down exceeds paid expenditures, and one
--     duplicate invoice is voided (status 'void') and must not be counted.
--   * Grant G-317 (stormwater): paid expenditures exceed cash drawn down, so the
--     town is carrying eligible costs it has not yet been reimbursed for.
--   * Budget line BL-26-02 (winter salt): FY2026 spending exceeds the amended budget.
--   * Grant G-366 (senior meals): closed with part of the award unspent.
--   * payroll is deliberately NOT in sample_allowlist.json, and vendors.tax_id /
--     vendors.remit_account_last4 are excluded, so you can see the guard refuse.
--
-- Rebuild the .sqlite file from this script with:  node scripts/verify-setup.js --rebuild

PRAGMA foreign_keys = ON;

CREATE TABLE funds (
  fund_id     TEXT PRIMARY KEY,
  fund_name   TEXT NOT NULL,
  fund_type   TEXT NOT NULL
);

CREATE TABLE departments (
  dept_id     TEXT PRIMARY KEY,
  dept_name   TEXT NOT NULL
);

CREATE TABLE vendors (
  vendor_id            TEXT PRIMARY KEY,
  vendor_name          TEXT NOT NULL,
  category             TEXT NOT NULL,
  tax_id               TEXT NOT NULL,   -- sensitive: not allow-listed
  remit_account_last4  TEXT NOT NULL    -- sensitive: not allow-listed
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
  grant_id        TEXT REFERENCES grants(grant_id),   -- NULL when not grant-funded
  vendor_id       TEXT NOT NULL REFERENCES vendors(vendor_id),
  invoice_number  TEXT NOT NULL,
  invoice_date    TEXT NOT NULL,
  paid_date       TEXT,                               -- NULL unless status = 'paid'
  amount_cents    INTEGER NOT NULL,
  memo            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('paid', 'pending', 'void'))
);

CREATE TABLE grant_drawdowns (
  drawdown_id    TEXT PRIMARY KEY,
  grant_id       TEXT NOT NULL REFERENCES grants(grant_id),
  request_date   TEXT NOT NULL,
  received_date  TEXT,                                -- NULL while pending
  amount_cents   INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('received', 'pending'))
);

-- Not allow-listed: present so the guard has something to refuse.
CREATE TABLE payroll (
  pay_id           TEXT PRIMARY KEY,
  employee_id      TEXT NOT NULL,
  dept_id          TEXT NOT NULL REFERENCES departments(dept_id),
  position_title   TEXT NOT NULL,
  pay_period_end   TEXT NOT NULL,
  gross_pay_cents  INTEGER NOT NULL
);


INSERT INTO funds (fund_id, fund_name, fund_type) VALUES
  ('100', 'General Fund', 'general'),
  ('210', 'Highway & Streets Fund', 'special-revenue'),
  ('250', 'Grants Fund', 'special-revenue'),
  ('400', 'Capital Projects Fund', 'capital-projects');

INSERT INTO departments (dept_id, dept_name) VALUES
  ('PW', 'Public Works'),
  ('PR', 'Parks & Recreation'),
  ('LIB', 'Library'),
  ('PD', 'Police'),
  ('SR', 'Senior Services'),
  ('FIN', 'Finance & Administration');

INSERT INTO vendors (vendor_id, vendor_name, category, tax_id, remit_account_last4) VALUES
  ('V-101', 'Sampleton Asphalt & Paving Co.', 'construction', '00-0000101', '4411'),
  ('V-102', 'Tri-County Aggregates', 'materials', '00-0000102', '9032'),
  ('V-103', 'Northline Engineering Group', 'professional-services', '00-0000103', '1187'),
  ('V-104', 'Granite Ridge Salt Supply', 'materials', '00-0000104', '6650'),
  ('V-105', 'Bluewater Civil Consultants', 'professional-services', '00-0000105', '2208'),
  ('V-106', 'Ridgeway Pipe & Precast', 'construction', '00-0000106', '7714'),
  ('V-107', 'Brightpath Learning Materials', 'supplies', '00-0000107', '3359'),
  ('V-108', 'Story Lane Events', 'services', '00-0000108', '5521'),
  ('V-109', 'Summit Public Safety Supply', 'equipment', '00-0000109', '8046'),
  ('V-110', 'Harvest Table Catering', 'services', '00-0000110', '1290'),
  ('V-111', 'Evergreen Landscape Services', 'services', '00-0000111', '6873'),
  ('V-112', 'Cobblestone Site Works', 'construction', '00-0000112', '4402'),
  ('V-113', 'Ledgerwell CPA Group', 'professional-services', '00-0000113', '9915');

INSERT INTO grants (grant_id, grant_name, grantor, grantor_type, fund_id, dept_id, award_cents, match_required_cents, period_start, period_end, status) VALUES
  ('G-402', 'Municipal Paving Program 2026', 'State Department of Transportation', 'state', '210', 'PW', 125000000, 31250000, '2026-01-01', '2027-06-30', 'active'),
  ('G-317', 'Stormwater Resilience Upgrade', 'FEMA Building Resilient Infrastructure and Communities', 'federal', '400', 'PW', 240000000, 80000000, '2025-07-01', '2028-06-30', 'active'),
  ('G-288', 'Early Literacy Outreach', 'Sampleton Community Foundation', 'private', '250', 'LIB', 7500000, 0, '2025-07-01', '2026-06-30', 'closed'),
  ('G-355', 'Community Policing Equipment', 'U.S. Department of Justice JAG Program', 'federal', '250', 'PD', 18000000, 0, '2025-10-01', '2027-09-30', 'active'),
  ('G-410', 'Riverside Trail Connector', 'State Recreational Trails Program', 'state', '400', 'PR', 42000000, 10500000, '2026-04-01', '2028-03-31', 'active'),
  ('G-366', 'Senior Meals Expansion', 'County Area Agency on Aging', 'county', '250', 'SR', 9600000, 0, '2025-07-01', '2026-06-30', 'closed');

INSERT INTO budget_lines (line_id, fiscal_year, dept_id, fund_id, account_code, line_description, adopted_cents, amended_cents) VALUES
  ('BL-26-01', 2026, 'PW', '210', '5410', 'Road resurfacing', 95000000, 160000000),
  ('BL-26-02', 2026, 'PW', '100', '5420', 'Winter road salt', 18000000, 18000000),
  ('BL-26-03', 2026, 'PW', '400', '5430', 'Stormwater capital improvements', 120000000, 120000000),
  ('BL-26-04', 2026, 'PR', '100', '5510', 'Parks maintenance', 32000000, 32000000),
  ('BL-26-05', 2026, 'LIB', '250', '5610', 'Literacy programs', 7500000, 7500000),
  ('BL-26-06', 2026, 'PD', '250', '5710', 'Public safety equipment', 18000000, 18000000),
  ('BL-26-07', 2026, 'SR', '250', '5810', 'Senior meals', 9600000, 9600000),
  ('BL-26-08', 2026, 'FIN', '100', '5910', 'Audit and accounting services', 6500000, 6500000),
  ('BL-27-01', 2027, 'PW', '210', '5410', 'Road resurfacing', 70000000, 70000000),
  ('BL-27-02', 2027, 'PW', '100', '5420', 'Winter road salt', 19000000, 19000000),
  ('BL-27-03', 2027, 'PW', '400', '5430', 'Stormwater capital improvements', 150000000, 150000000),
  ('BL-27-04', 2027, 'PR', '400', '5520', 'Trail construction', 42000000, 42000000),
  ('BL-27-05', 2027, 'PR', '100', '5510', 'Parks maintenance', 33000000, 33000000),
  ('BL-27-06', 2027, 'PD', '250', '5710', 'Public safety equipment', 9000000, 9000000),
  ('BL-27-07', 2027, 'FIN', '100', '5910', 'Audit and accounting services', 6800000, 6800000);

INSERT INTO expenditures (expenditure_id, fiscal_year, line_id, grant_id, vendor_id, invoice_number, invoice_date, paid_date, amount_cents, memo, status) VALUES
  ('E-1001', 2026, 'BL-26-01', 'G-402', 'V-103', 'INV-26000', '2026-04-15', '2026-04-29', 8450000, 'Paving program design and bid documents', 'paid'),
  ('E-1002', 2026, 'BL-26-01', 'G-402', 'V-101', 'INV-26007', '2026-05-20', '2026-06-03', 21780000, 'Elm Street resurfacing', 'paid'),
  ('E-1003', 2026, 'BL-26-01', 'G-402', 'V-102', 'INV-26014', '2026-06-10', '2026-06-24', 6325000, 'Base aggregate, Elm and Oak', 'paid'),
  ('E-1004', 2026, 'BL-26-01', 'G-402', 'V-101', 'INV-26021', '2026-06-24', '2026-07-08', 18960000, 'Oak Avenue resurfacing', 'paid'),
  ('E-1005', 2026, 'BL-26-01', 'G-402', 'V-101', 'INV-26028', '2026-06-24', NULL, 18960000, 'Oak Avenue resurfacing (duplicate invoice, voided)', 'void'),
  ('E-1006', 2027, 'BL-27-01', 'G-402', 'V-101', 'INV-26035', '2026-07-22', '2026-08-05', 16240000, 'Maple Drive resurfacing', 'paid'),
  ('E-1007', 2027, 'BL-27-01', 'G-402', 'V-102', 'INV-26042', '2026-08-14', '2026-08-28', 4875000, 'Base aggregate, Maple and Pine', 'paid'),
  ('E-1008', 2027, 'BL-27-01', 'G-402', 'V-103', 'INV-26049', '2026-09-09', '2026-09-23', 3920000, 'Construction inspection services', 'paid'),
  ('E-1009', 2027, 'BL-27-01', 'G-402', 'V-101', 'INV-26056', '2026-09-30', '2026-10-14', 12615000, 'Pine Street resurfacing', 'paid'),
  ('E-1010', 2027, 'BL-27-01', 'G-402', 'V-101', 'INV-26063', '2026-10-21', NULL, 9880000, 'Cedar Lane resurfacing', 'pending'),
  ('E-1011', 2026, 'BL-26-01', NULL, 'V-101', 'INV-26070', '2025-09-12', '2025-09-26', 14200000, 'Main Street patching', 'paid'),
  ('E-1012', 2026, 'BL-26-01', NULL, 'V-102', 'INV-26077', '2025-10-03', '2025-10-17', 6150000, 'Shoulder stone', 'paid'),
  ('E-1013', 2026, 'BL-26-02', NULL, 'V-104', 'INV-26084', '2025-12-05', '2025-12-19', 6840000, 'Road salt, December delivery', 'paid'),
  ('E-1014', 2026, 'BL-26-02', NULL, 'V-104', 'INV-26091', '2026-01-16', '2026-01-30', 7120000, 'Road salt, January delivery', 'paid'),
  ('E-1015', 2026, 'BL-26-02', NULL, 'V-104', 'INV-26098', '2026-02-20', '2026-03-06', 5680000, 'Road salt, February delivery', 'paid'),
  ('E-1016', 2027, 'BL-27-02', NULL, 'V-104', 'INV-26105', '2026-10-28', NULL, 3450000, 'Road salt pre-season purchase', 'pending'),
  ('E-1017', 2026, 'BL-26-03', 'G-317', 'V-105', 'INV-26112', '2025-08-18', '2025-09-01', 12500000, 'Hydrologic study', 'paid'),
  ('E-1018', 2026, 'BL-26-03', 'G-317', 'V-105', 'INV-26119', '2025-11-07', '2025-11-21', 18750000, 'Culvert replacement design', 'paid'),
  ('E-1019', 2026, 'BL-26-03', 'G-317', 'V-106', 'INV-26126', '2026-03-26', '2026-04-09', 27430000, 'Culvert materials, phase 1', 'paid'),
  ('E-1020', 2026, 'BL-26-03', 'G-317', 'V-106', 'INV-26133', '2026-05-29', '2026-06-12', 31860000, 'Culvert installation, phase 1', 'paid'),
  ('E-1021', 2027, 'BL-27-03', 'G-317', 'V-106', 'INV-26140', '2026-08-27', '2026-09-10', 22915000, 'Culvert materials, phase 2', 'paid'),
  ('E-1022', 2027, 'BL-27-03', 'G-317', 'V-105', 'INV-26147', '2026-10-09', '2026-10-23', 4600000, 'Construction administration', 'paid'),
  ('E-1023', 2026, 'BL-26-03', NULL, 'V-106', 'INV-26154', '2026-05-29', '2026-06-12', 10620000, 'Culvert installation, phase 1 (local match)', 'paid'),
  ('E-1024', 2026, 'BL-26-05', 'G-288', 'V-107', 'INV-26161', '2025-08-05', '2025-08-19', 2180000, 'Early reader book kits', 'paid'),
  ('E-1025', 2026, 'BL-26-05', 'G-288', 'V-107', 'INV-26168', '2025-10-14', '2025-10-28', 1945000, 'Bilingual picture books', 'paid'),
  ('E-1026', 2026, 'BL-26-05', 'G-288', 'V-108', 'INV-26175', '2026-01-22', '2026-02-05', 1260000, 'Family reading night series', 'paid'),
  ('E-1027', 2026, 'BL-26-05', 'G-288', 'V-107', 'INV-26182', '2026-03-11', '2026-03-25', 1610000, 'Literacy activity packs', 'paid'),
  ('E-1028', 2026, 'BL-26-05', 'G-288', 'V-108', 'INV-26189', '2026-05-28', '2026-06-11', 500000, 'Summer reading kickoff event', 'paid'),
  ('E-1029', 2026, 'BL-26-06', 'G-355', 'V-109', 'INV-26196', '2025-11-19', '2025-12-03', 6420000, 'Body-worn cameras', 'paid'),
  ('E-1030', 2026, 'BL-26-06', 'G-355', 'V-109', 'INV-26203', '2026-02-12', '2026-02-26', 4875000, 'Portable radios', 'paid'),
  ('E-1031', 2027, 'BL-27-06', 'G-355', 'V-109', 'INV-26210', '2026-08-06', '2026-08-20', 3150000, 'De-escalation training simulator', 'paid'),
  ('E-1032', 2026, 'BL-26-07', 'G-366', 'V-110', 'INV-26217', '2025-08-29', '2025-09-12', 1580000, 'Senior meals, July-August', 'paid'),
  ('E-1033', 2026, 'BL-26-07', 'G-366', 'V-110', 'INV-26224', '2025-11-26', '2025-12-10', 1615000, 'Senior meals, September-November', 'paid'),
  ('E-1034', 2026, 'BL-26-07', 'G-366', 'V-110', 'INV-26231', '2026-02-27', '2026-03-13', 1590000, 'Senior meals, December-February', 'paid'),
  ('E-1035', 2026, 'BL-26-07', 'G-366', 'V-110', 'INV-26238', '2026-05-29', '2026-06-12', 1640000, 'Senior meals, March-May', 'paid'),
  ('E-1036', 2026, 'BL-26-07', 'G-366', 'V-110', 'INV-26245', '2026-06-26', '2026-07-10', 1610000, 'Senior meals, June', 'paid'),
  ('E-1037', 2026, 'BL-26-04', NULL, 'V-111', 'INV-26252', '2025-07-25', '2025-08-08', 4200000, 'Mowing and grounds, Q1', 'paid'),
  ('E-1038', 2026, 'BL-26-04', NULL, 'V-111', 'INV-26259', '2025-09-26', '2025-10-10', 4200000, 'Mowing and grounds, Q2', 'paid'),
  ('E-1039', 2026, 'BL-26-04', NULL, 'V-111', 'INV-26266', '2026-04-24', '2026-05-08', 4350000, 'Spring cleanup and planting', 'paid'),
  ('E-1040', 2026, 'BL-26-04', NULL, 'V-111', 'INV-26273', '2026-06-19', '2026-07-03', 4350000, 'Mowing and grounds, Q4', 'paid'),
  ('E-1041', 2027, 'BL-27-05', NULL, 'V-111', 'INV-26280', '2026-07-31', '2026-08-14', 4400000, 'Mowing and grounds, Q1', 'paid'),
  ('E-1042', 2027, 'BL-27-05', NULL, 'V-111', 'INV-26287', '2026-09-25', '2026-10-09', 4400000, 'Mowing and grounds, Q2', 'paid'),
  ('E-1043', 2027, 'BL-27-04', 'G-410', 'V-103', 'INV-26294', '2026-07-17', '2026-07-31', 3880000, 'Trail alignment and permitting', 'paid'),
  ('E-1044', 2027, 'BL-27-04', 'G-410', 'V-112', 'INV-26301', '2026-10-16', NULL, 5240000, 'Trail corridor clearing', 'pending'),
  ('E-1045', 2026, 'BL-26-08', NULL, 'V-113', 'INV-26308', '2025-12-12', '2025-12-26', 5850000, 'Annual financial statement audit', 'paid'),
  ('E-1046', 2027, 'BL-27-07', NULL, 'V-113', 'INV-26315', '2026-10-30', NULL, 1950000, 'Interim audit fieldwork', 'pending');

INSERT INTO grant_drawdowns (drawdown_id, grant_id, request_date, received_date, amount_cents, status) VALUES
  ('D-01', 'G-402', '2026-04-20', '2026-05-01', 25000000, 'received'),
  ('D-02', 'G-402', '2026-06-20', '2026-07-01', 40000000, 'received'),
  ('D-03', 'G-402', '2026-09-02', '2026-09-15', 35000000, 'received'),
  ('D-04', 'G-402', '2026-11-05', NULL, 15000000, 'pending'),
  ('D-05', 'G-317', '2025-12-01', '2025-12-15', 31250000, 'received'),
  ('D-06', 'G-317', '2026-06-26', '2026-07-10', 59290000, 'received'),
  ('D-07', 'G-317', '2026-10-06', NULL, 22915000, 'pending'),
  ('D-08', 'G-288', '2025-12-20', '2026-01-05', 4125000, 'received'),
  ('D-09', 'G-288', '2026-07-01', '2026-07-15', 3370000, 'received'),
  ('D-10', 'G-355', '2026-03-16', '2026-03-30', 11295000, 'received'),
  ('D-11', 'G-366', '2025-12-29', '2026-01-10', 3195000, 'received'),
  ('D-12', 'G-366', '2026-07-06', '2026-07-20', 4840000, 'received');

INSERT INTO payroll (pay_id, employee_id, dept_id, position_title, pay_period_end, gross_pay_cents) VALUES
  ('P-01', 'EMP-014', 'PW', 'Equipment Operator II', '2026-10-15', 248000),
  ('P-02', 'EMP-022', 'PW', 'Highway Superintendent', '2026-10-15', 412500),
  ('P-03', 'EMP-031', 'LIB', 'Children''s Librarian', '2026-10-15', 231000),
  ('P-04', 'EMP-047', 'PD', 'Patrol Officer', '2026-10-15', 296000),
  ('P-05', 'EMP-052', 'FIN', 'Town Accountant', '2026-10-15', 318500),
  ('P-06', 'EMP-063', 'SR', 'Senior Center Coordinator', '2026-10-15', 204000);

#!/usr/bin/env node
/**
 * verify-setup.js: check a Civic-Chain Auditor install and print the client config.
 *
 *   node scripts/verify-setup.js                  check everything, build the municipal demo if missing
 *   node scripts/verify-setup.js --pack <name>    build and check a specific bundled pack instead
 *   node scripts/verify-setup.js --list-packs     list the bundled packs you can pass to --pack
 *   node scripts/verify-setup.js --rebuild        rebuild the chosen demo db from its SQL seed
 *   node scripts/verify-setup.js --core <dir>     path to your auditor-core checkout
 *   node scripts/verify-setup.js --db <file> --allowlist <file>   check your own ledger instead
 *
 * What it does, all locally:
 *   1. Checks Node is 22 or newer and node:sqlite is available.
 *   2. Builds the chosen pack's demo .sqlite from its SQL seed if it is missing
 *      (or with --rebuild). Defaults to the municipal pack. The .sqlite files are
 *      the only files it ever writes.
 *   3. Validates the allow-list and checks every table and column it names
 *      exists in the database (opened read-only).
 *   4. Finds auditor-core, checks its dependencies are installed, and loads the
 *      warehouse through the engine itself as a smoke test.
 *   5. Prints the mcpServers JSON to paste into Claude Code, Cursor or Claude
 *      Desktop, including CIVIC_RULESET_PATH for a signed pack.
 *
 * What it never does: make network requests, spawn processes, read any
 * credential or environment secret, or modify anything outside the assets/
 * folder. The only environment variables it touches are the two it sets for
 * the smoke test (CIVIC_DB_PATH, CIVIC_ALLOWLIST_PATH) and the optional
 * CIVIC_CORE it reads to find your checkout. No dependencies beyond Node.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SKILL_DIR = path.resolve(__dirname, '..');
const ASSETS = path.join(SKILL_DIR, 'assets');
const DEFAULT_DB = path.join(ASSETS, 'sample_municipal_budget.sqlite');
const DEFAULT_SQL = path.join(ASSETS, 'sample_municipal_budget.sql');
const DEFAULT_ALLOWLIST = path.join(ASSETS, 'sample_allowlist.json');
const RESERVED = ['saas', 'markets', 'enron', 'lseg', 'audit'];
const NAME = /^[a-z][a-z0-9_]*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── output ────────────────────────────────────────────────────────────────
let failures = 0;
let warnings = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const warn = (msg) => {
    warnings += 1;
    console.log(`  ! ${msg}`);
};
const fail = (msg) => {
    failures += 1;
    console.log(`  ✖ ${msg}`);
};
const section = (title) => console.log(`\n${title}`);

// ── arguments ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = { rebuild: false, help: false, listPacks: false, pack: null, core: null, db: null, allowlist: null };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--rebuild') args.rebuild = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else if (a === '--list-packs') args.listPacks = true;
        else if (a === '--pack') {
            const value = argv[i + 1];
            if (!value || value.startsWith('--')) {
                console.error(`${a} needs a pack name (try --list-packs).`);
                process.exit(2);
            }
            args.pack = value;
            i += 1;
        } else if (a === '--core' || a === '--db' || a === '--allowlist') {
            const value = argv[i + 1];
            if (!value || value.startsWith('--')) {
                console.error(`${a} needs a path.`);
                process.exit(2);
            }
            args[a.slice(2)] = path.resolve(value);
            i += 1;
        } else {
            console.error(`Unknown argument: ${a} (try --help)`);
            process.exit(2);
        }
    }
    return args;
}

// ── packs ─────────────────────────────────────────────────────────────────
// The bundled packs, from the manifest mirrored from auditor-core/assets/packs.json
// (drift-tested). The skill copy is flat, so every file sits directly in ASSETS.
function loadPacks() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ASSETS, 'packs.json'), 'utf8')).packs ?? [];
    } catch {
        return [];
    }
}

function resolvePack(name) {
    const p = loadPacks().find((x) => x.pack === name || x.warehouse === name);
    if (!p) return null;
    return {
        warehouse: p.warehouse,
        label: p.label,
        sqlPath: path.join(ASSETS, p.sql),
        dbPath: path.join(ASSETS, p.sql.replace(/\.sql$/, '.sqlite')),
        allowlistPath: path.join(ASSETS, p.allowlist),
        rulesetPath: path.join(ASSETS, p.ruleset),
    };
}

function usage() {
    const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
    console.log(header.replace(/^#!.*\n/, '').replace(/^\/\*\*?|^ \* ?/gm, '').trim());
}

// ── checks ────────────────────────────────────────────────────────────────
function checkNode() {
    section('Node.js');
    const major = Number(process.versions.node.split('.')[0]);
    if (major >= 22) ok(`Node ${process.versions.node}`);
    else fail(`Node ${process.versions.node}; the Civic-Chain Auditor needs Node 22 or newer (it uses the built-in node:sqlite).`);
    try {
        const sqlite = require('node:sqlite');
        ok('node:sqlite is available');
        return sqlite;
    } catch {
        fail('node:sqlite could not be loaded. Upgrade to Node 22.13+ (or run with --experimental-sqlite on 22.5-22.12).');
        return null;
    }
}

function buildDemoDb(sqlite, dbPath, sqlPath, rebuild) {
    section('Database');
    if (fs.existsSync(dbPath) && !rebuild) {
        ok(`found ${dbPath}`);
        return true;
    }
    // Only a bundled pack carries a SQL seed we can build from; a user --db must exist.
    if (!sqlPath) {
        fail(`${dbPath} does not exist. (--rebuild only rebuilds a bundled demo database.)`);
        return false;
    }
    if (!fs.existsSync(sqlPath)) {
        fail(`the seed script ${sqlPath} is missing, so the demo database cannot be built.`);
        return false;
    }
    // Build beside the target, then rename, so a failed build never leaves a half-written file.
    const tmp = `${dbPath}.building-${process.pid}`;
    try {
        fs.rmSync(tmp, { force: true });
        const db = new sqlite.DatabaseSync(tmp);
        db.exec(fs.readFileSync(sqlPath, 'utf8'));
        db.close();
        fs.renameSync(tmp, dbPath);
        ok(`${rebuild ? 'rebuilt' : 'built'} ${dbPath} from ${path.basename(sqlPath)}`);
        return true;
    } catch (error) {
        fs.rmSync(tmp, { force: true });
        fail(`could not build the demo database: ${error.message}`);
        return false;
    }
}

function checkAllowlist(sqlite, dbPath, allowlistPath) {
    section('Allow-list');
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    } catch (error) {
        fail(`could not read ${allowlistPath} as JSON: ${error.message}`);
        return null;
    }

    const problems = [];
    if (typeof doc.name !== 'string' || !NAME.test(doc.name)) problems.push('"name" must match [a-z][a-z0-9_]*');
    else if (RESERVED.includes(doc.name)) problems.push(`"name" may not be a built-in warehouse (${RESERVED.join(', ')})`);
    const tables = doc.tables && typeof doc.tables === 'object' && !Array.isArray(doc.tables) ? doc.tables : null;
    if (!tables || Object.keys(tables).length === 0) problems.push('"tables" must map at least one table to its columns');
    for (const [table, cols] of Object.entries(tables ?? {})) {
        if (!IDENTIFIER.test(table) || table.toLowerCase().startsWith('sqlite_')) problems.push(`bad table name "${table}"`);
        if (!Array.isArray(cols) || cols.length === 0) problems.push(`"${table}" must list at least one column`);
        else for (const c of cols) if (typeof c !== 'string' || !IDENTIFIER.test(c)) problems.push(`bad column ${JSON.stringify(c)} in "${table}"`);
    }
    if (doc.notes !== undefined && (!Array.isArray(doc.notes) || doc.notes.some((n) => typeof n !== 'string'))) {
        problems.push('"notes" must be an array of strings');
    }
    if (problems.length > 0) {
        for (const p of problems) fail(p);
        return null;
    }
    const queryCount = doc.queries && typeof doc.queries === 'object' ? Object.keys(doc.queries).length : 0;
    ok(`warehouse "${doc.name}" with ${Object.keys(tables).length} allow-listed tables and ${queryCount} named queries`);

    let db;
    try {
        db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    } catch (error) {
        fail(`could not open ${dbPath} read-only: ${error.message}`);
        return null;
    }
    try {
        let allPresent = true;
        for (const [table, cols] of Object.entries(tables)) {
            const info = db.prepare(`PRAGMA table_info(${table})`).all();
            if (info.length === 0) {
                fail(`table "${table}" is in the allow-list but not in the database`);
                allPresent = false;
                continue;
            }
            const names = new Set(info.map((c) => c.name));
            const missing = cols.filter((c) => !names.has(c));
            if (missing.length > 0) {
                fail(`"${table}" is missing allow-listed column(s): ${missing.join(', ')}`);
                allPresent = false;
                continue;
            }
            const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
            const hidden = info.length - cols.length;
            ok(`${table}: ${n} rows, ${cols.length} columns permitted${hidden > 0 ? ` (${hidden} withheld)` : ''}`);
        }
        const present = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all()
            .map((r) => r.name);
        const withheld = present.filter((t) => !(t in tables));
        if (withheld.length > 0) ok(`not allow-listed, so the guard will refuse it: ${withheld.join(', ')}`);
        return allPresent ? doc : null;
    } finally {
        db.close();
    }
}

function findCore(explicit) {
    const candidates = [explicit, process.env.CIVIC_CORE, path.resolve(SKILL_DIR, '..', '..', 'auditor-core')].filter(Boolean);
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'bin', 'auditor.js'))) return path.resolve(dir);
    }
    return null;
}

async function checkCore(coreArg, dbPath, allowlistPath, doc, rulesetPath = null) {
    section('auditor-core');
    const core = findCore(coreArg);
    if (!core) {
        fail('auditor-core not found. Pass --core /path/to/vanguard-mcp/auditor-core (or set CIVIC_CORE).');
        return null;
    }
    ok(`found ${core}`);

    let pkg = null;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8'));
    } catch {
        /* reported below */
    }
    const CORE_NAMES = ['@civic-chain/auditor'];
    if (!CORE_NAMES.includes(pkg?.name)) warn(`${core}/package.json does not identify as the Civic-Chain Auditor engine (@civic-chain/auditor); continuing anyway.`);

    const deps = ['@modelcontextprotocol/sdk', 'node-sql-parser', '@anthropic-ai/sdk'];
    const missing = deps.filter((d) => !fs.existsSync(path.join(core, 'node_modules', ...d.split('/'), 'package.json')));
    if (missing.length === 0) ok('dependencies installed');
    else fail(`dependencies missing (${missing.join(', ')}). Run: cd "${core}" && npm install`);

    const supportsCustom = fs.existsSync(path.join(core, 'src', 'custom.js'));
    if (supportsCustom) ok('custom warehouses supported (CIVIC_DB_PATH / CIVIC_ALLOWLIST_PATH)');
    else fail('this auditor-core predates custom warehouse support (no src/custom.js). Update your checkout.');

    if (supportsCustom && missing.length === 0 && doc) {
        // Load the warehouse through the engine itself, exactly as the MCP server will.
        process.env.CIVIC_DB_PATH = dbPath;
        process.env.CIVIC_ALLOWLIST_PATH = allowlistPath;
        // A signed pack serves its queries from the ruleset; pin it so the smoke
        // test loads the pack the same way the config tells the server to.
        if (rulesetPath) process.env.CIVIC_RULESET_PATH = rulesetPath;
        try {
            const { warehouseSchema } = await import(pathToFileURL(path.join(core, 'src', 'warehouses.js')).href);
            const schema = warehouseSchema(doc.name);
            ok(`engine serves "${schema.warehouse}" with ${schema.tables.length} tables; free text: ${schema.freeText}`);
            const { loadCustomWarehouse } = await import(pathToFileURL(path.join(core, 'src', 'custom.js')).href);
            const custom = loadCustomWarehouse();
            const names = Object.keys(custom?.queries ?? {});
            if (names.length > 0) ok(`named queries compile: ${names.map((n) => `${custom.name}/${n}`).join(', ')}`);
            if (rulesetPath && custom?.ruleset) ok(`ruleset ${custom.ruleset.name}/${custom.ruleset.version}: ${custom.ruleset.status}${custom.ruleset.signedBy ? ` (key ${custom.ruleset.signedBy})` : ''}`);
        } catch (error) {
            fail(`the engine could not load the warehouse: ${error.message}`);
        }
    }
    return core;
}

function credentialReminder() {
    // Deliberately does not read the environment: this script never inspects credentials.
    section('Credential');
    console.log('  Free-text questions (execute_financial_query) need an Anthropic API key;');
    console.log('  canonical queries, controls and audit verification do not. Replace the');
    console.log('  placeholder in the "env" block below with your key.');
}

function printConfig(core, dbPath, allowlistPath, { rulesetPath = null, serverKey = 'civic-chain-auditor' } = {}) {
    const env = {
        CIVIC_DB_PATH: dbPath,
        CIVIC_ALLOWLIST_PATH: allowlistPath,
    };
    // A signed pack serves through its ruleset, so the config pins it; its named
    // queries replace the allow-list's and every result reports the signature.
    if (rulesetPath) env.CIVIC_RULESET_PATH = rulesetPath;
    env.ANTHROPIC_API_KEY = '<your-anthropic-api-key>';
    const config = {
        mcpServers: {
            [serverKey]: {
                command: process.execPath,
                args: [path.join(core ?? '/path/to/vanguard-mcp/auditor-core', 'bin', 'auditor.js'), 'mcp'],
                env,
            },
        },
    };
    section('MCP client config');
    console.log('  Paste this into one of:');
    console.log('    Claude Code     .mcp.json in your project root');
    console.log('    Cursor          .cursor/mcp.json (project) or ~/.cursor/mcp.json (global)');
    console.log('    Claude Desktop  claude_desktop_config.json');
    console.log(`  If the file already has an "mcpServers" object, add only the "${serverKey}" entry to it.`);
    console.log('  "command" is the absolute path of the Node that ran this check, so GUI apps find it.\n');
    console.log(JSON.stringify(config, null, 2));
}

function listPacks() {
    const packs = loadPacks();
    if (packs.length === 0) {
        console.log('No packs.json manifest found beside this script.');
        return;
    }
    console.log(`\nBundled packs (${packs.length}) — pass one to --pack:\n`);
    for (const p of packs) console.log(`  ${p.warehouse.padEnd(13)} ${p.label}`);
    console.log('\nExample: node scripts/verify-setup.js --pack construction');
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        usage();
        return;
    }
    if (args.listPacks) {
        listPacks();
        return;
    }

    // Default to the municipal demo; --pack picks another bundled pack; --db
    // points at the user's own ledger (which must already exist).
    let dbPath = args.db ?? DEFAULT_DB;
    let allowlistPath = args.allowlist ?? DEFAULT_ALLOWLIST;
    let sqlPath = dbPath === DEFAULT_DB ? DEFAULT_SQL : null;
    let rulesetPath = null;
    let serverKey = 'civic-chain-auditor';
    if (args.pack) {
        const p = resolvePack(args.pack);
        if (!p) {
            const names = loadPacks().map((x) => x.warehouse).join(', ');
            console.error(`Unknown pack "${args.pack}". Available: ${names || '(no manifest found)'}`);
            process.exit(2);
        }
        dbPath = p.dbPath;
        allowlistPath = p.allowlistPath;
        sqlPath = p.sqlPath;
        rulesetPath = p.rulesetPath;
        serverKey = `civic-chain-${p.warehouse}`;
    }

    console.log('Civic-Chain Auditor setup check (local only: no network, no subprocesses)');

    const sqlite = checkNode();
    let doc = null;
    if (sqlite && buildDemoDb(sqlite, dbPath, sqlPath, args.rebuild)) doc = checkAllowlist(sqlite, dbPath, allowlistPath);
    const core = await checkCore(args.core, dbPath, allowlistPath, doc, rulesetPath);
    credentialReminder();
    printConfig(core, dbPath, allowlistPath, { rulesetPath, serverKey });

    section('Result');
    if (failures > 0) {
        console.log(`  ${failures} problem(s) to fix above${warnings ? `, ${warnings} warning(s)` : ''}.`);
        process.exitCode = 1;
    } else {
        console.log(`  Ready${warnings ? `, with ${warnings} warning(s)` : ''}. Restart your MCP client after adding the config.`);
        if (rulesetPath) console.log(`  Try a ${doc?.name ?? args.pack} named query, e.g. run_canonical { "name": "${doc?.name ?? args.pack}/..." } (see references/setup.md).`);
        else console.log('  Try: "How much of the paving grant (G-402) has been spent, by vendor? Include the result hash."');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

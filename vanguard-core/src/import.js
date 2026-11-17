/**
 * `cc-auditor import`: bring a buyer's expenditure CSV into the engine.
 *
 * The flow is two steps on purpose. First, with no `--map`, the engine reads
 * the file's headers (and a sample of rows to confirm types) and *proposes* a
 * column mapping onto the canonical schema; it writes nothing. The operator
 * reviews that mapping, adjusts it if needed, and re-runs with `--map` to
 * confirm. Only a confirmed mapping is ever written, and the confirmed mapping
 * is saved beside the ledger and recorded in the audit log, so the import is
 * reproducible and reviewable.
 *
 * What it records: the source file's SHA-256, its byte length, the row count and
 * the confirmed mapping, as the first entry of the imported ledger's own audit
 * chain. Every figure the three named queries later produce therefore ties back
 * to the exact bytes that were imported and the exact mapping that was confirmed.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened (paths.js, resolveImportPath).
 */

import { basename } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolveImportPath, importedLedgerPaths, ensureParent, importDir } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    buildLedgerFromCsv,
    CANONICAL_SCHEMA_VERSION,
    ImportError,
} from './import-csv.js';

const PKG = '@civic-chain/auditor';

/** The three named queries the import gate re-runs. */
export const GATE_QUERIES = ['grant-status', 'spending-by-vendor', 'budget-variance'];

/** Read a sample of a CSV (headers + up to `n` rows) without a full parse cost on huge files. */
function readSample(text, n = 25) {
    const { headers, rows } = parseCsv(text);
    return { headers, rows, sample: rows.slice(0, n) };
}

/**
 * Run an import, or propose a mapping when none is confirmed yet.
 *
 * @param {object} params
 * @param {string} params.file            CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed mapping; null = propose only
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate]      after import, run the three named queries (default true)
 * @param {object|null} [params.signer]   audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runImport({ file, mapping = null, env = process.env, runGate = true, signer = null }) {
    const csvPath = resolveImportPath(file, { env });
    const text = readFileSync(csvPath, 'utf8');
    const { headers, sample } = readSample(text);

    // Propose-only: read and suggest, write nothing.
    if (!mapping) {
        const proposal = proposeMapping(headers, sample);
        return { stage: 'propose', csvPath, file: basename(file), headers, ...proposal };
    }

    // Confirmed: build the ledger into a fresh per-import subtree of the data
    // directory. A fresh chain per import keeps result hashes reproducible.
    const paths = importedLedgerPaths(basename(file), { env });
    rmSync(paths.logPath, { force: true });

    const built = buildLedgerFromCsv({
        csvPath,
        mapping,
        dbPath: paths.dbPath,
        allowlistPath: paths.allowlistPath,
    });

    // Persist the confirmed mapping (reviewable, and re-usable with --map).
    ensureParent(paths.mappingPath);
    writeFileSync(
        paths.mappingPath,
        JSON.stringify({ canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION, source: basename(file), mapping: built.mapping }, null, 2),
    );

    // Record the import as the first audit entry: the source bytes' hash is the
    // anchor every later figure ties back to.
    const { append } = await import('./audit.js');
    const importEntry = append(
        {
            kind: 'import',
            question: `Imported ${built.counts.rowCount} expenditure row(s) from ${basename(file)}`,
            sourceFile: basename(file),
            sourceFileSha256: built.sourceFileSha256,
            byteLength: built.byteLength,
            rowCount: built.counts.rowCount,
            counts: built.counts,
            mapping: built.mapping,
            canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
            tables: ['expenditures', 'vendors', 'departments', 'funds', 'budget_lines', 'grants'],
            resultHash: built.sourceFileSha256,
            llmScope: 'none',
            dataModified: true,
            at: new Date().toISOString(),
        },
        { path: paths.logPath, complianceTags: ['import'], signer },
    );

    const result = {
        stage: 'imported',
        file: basename(file),
        csvPath,
        paths,
        counts: built.counts,
        sourceFileSha256: built.sourceFileSha256,
        byteLength: built.byteLength,
        mapping: built.mapping,
        canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
        audit: { seq: importEntry.seq, hash: importEntry.hash, signed: Boolean(importEntry.signature) },
        gate: null,
        config: null,
    };

    if (runGate) result.gate = await runGateQueries(paths, signer);

    result.config = {
        mcpServers: {
            'civic-chain-auditor': {
                command: 'npx',
                args: ['-y', PKG, 'mcp'],
                env: { CIVIC_DB_PATH: paths.dbPath, CIVIC_ALLOWLIST_PATH: paths.allowlistPath },
            },
        },
    };
    return result;
}

/**
 * Run the three canonical named queries against an imported ledger and report
 * each one's integrity and finding counts. This is the import gate: a clean
 * import answers all three with integrity 'pass'.
 *
 * @param {{ dbPath: string, allowlistPath: string, logPath: string }} paths
 * @param {object|null} signer
 * @returns {Promise<{ ok: boolean, queries: object[] }>}
 */
export async function runGateQueries(paths, signer = null) {
    const { loadCustomWarehouse } = await import('./custom.js');
    const { guard } = await import('./guard.js');
    const { runNamedQuery } = await import('./named-run.js');
    const warehouse = loadCustomWarehouse({
        env: { CIVIC_DB_PATH: paths.dbPath, CIVIC_ALLOWLIST_PATH: paths.allowlistPath, CIVIC_AUDIT_LOG: paths.logPath },
    });
    const queries = [];
    for (const name of GATE_QUERIES) {
        const out = runNamedQuery(warehouse, name, {}, { guard, signer });
        queries.push({ name, rowCount: out.rows.length, integrity: out.integrity, findings: out.findings });
    }
    return { ok: queries.every((q) => q.integrity === 'pass'), queries };
}

// ── formatting ──────────────────────────────────────────────────────────────

/** Format a propose-stage result for the terminal. */
function formatPropose(r) {
    const lines = [`Proposed mapping for ${r.file} (nothing written yet)`, ''];
    const width = Math.max(...r.fields.map((f) => f.field.length));
    for (const f of r.fields) {
        const mark = f.header ? '→' : (f.required ? '✖' : '·');
        const target = f.header ? `"${f.header}"` : (f.required ? 'UNMAPPED (required)' : 'unmapped');
        lines.push(`  ${f.field.padEnd(width)}  ${mark} ${target}`);
    }
    lines.push('');
    if (r.unmappedHeaders.length) lines.push(`  Unused CSV columns: ${r.unmappedHeaders.join(', ')}`);
    if (r.missingRequired.length) {
        lines.push('');
        lines.push(`  ✖ Required field(s) not mapped: ${r.missingRequired.join(', ')}. Supply a mapping with --map.`);
    } else {
        const mapping = Object.fromEntries(r.fields.filter((f) => f.header).map((f) => [f.field, f.header]));
        lines.push('  To import with this mapping, save it and pass it with --map:');
        lines.push('');
        lines.push(JSON.stringify(mapping, null, 2));
    }
    return lines.join('\n');
}

/** Format an imported-stage result for the terminal. */
function formatImported(r) {
    const c = r.counts;
    const lines = [
        `Imported ${r.file}: ${c.rowCount} expenditure row(s)`,
        '',
        `  source SHA-256 : ${r.sourceFileSha256}`,
        `  bytes          : ${r.byteLength}`,
        `  derived        : ${c.vendors} vendor(s), ${c.departments} department(s), ${c.funds} fund(s), ${c.budgetLines} budget line(s), ${c.grants} grant(s)`,
        `  schema         : ${r.canonicalSchemaVersion}`,
        `  ledger         : ${r.paths.dbPath}`,
        `  mapping saved  : ${r.paths.mappingPath}`,
        `  audit entry    : #${r.audit.seq} ${r.audit.hash.slice(0, 16)}… (${r.audit.signed ? 'signed' : 'unsigned'})`,
    ];
    if (r.gate) {
        lines.push('');
        lines.push(`  Named-query gate: ${r.gate.ok ? 'clean integrity on all three' : 'INTEGRITY FLAGGED'}`);
        for (const q of r.gate.queries) {
            lines.push(`    ${q.name.padEnd(20)} ${q.rowCount} row(s)  integrity ${q.integrity}  ${q.findings} finding(s)`);
        }
    }
    if (r.config) {
        lines.push('');
        lines.push('Point your MCP client at the imported ledger (paste into .mcp.json):');
        lines.push('');
        lines.push(JSON.stringify(r.config, null, 2));
    }
    return lines.join('\n');
}

/** Format any import result for the terminal. */
export function formatImport(r) {
    if (r.stage === 'propose') return formatPropose(r);
    if (r.stage === 'imported') return formatImported(r);
    return JSON.stringify(r, null, 2);
}

export { ImportError, importDir };

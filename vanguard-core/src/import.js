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
import { resolveImportPath, importedLedgerPaths, ensureParent, importDir, assetPath } from './paths.js';
import {
    parseCsv,
    proposeMapping,
    buildLedgerFromCsv,
    applyGrantRegisterToLedger,
    CANONICAL_SCHEMA_VERSION,
    CANONICAL_GRANT_FIELDS,
    ImportError,
} from './import-csv.js';
import { loadRuleset } from './ruleset.js';

const PKG = '@civic-chain/auditor';

/** The bundled Civic-Chain ruleset for the canonical municipal schema (S9). */
export const MUNICIPAL_RULESET_PATH = assetPath('municipal', 'ruleset.municipal-v1.json');

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
 * A grant register can be imported alongside the expenditures (multi-file): the
 * expenditure CSV builds the ledger, then the register fills the `grants` table
 * with real award amounts so municipal/grant-status is meaningful. Each file
 * records its own source-SHA-256 audit entry on the ledger's chain.
 *
 * @param {object} params
 * @param {string} params.file            CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed mapping; null = propose only
 * @param {{ file: string, mapping: (Record<string,string>|null) }|null} [params.grantRegister]
 *   an optional grant-register file to apply after the expenditure import
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate]      after import, run the three named queries (default true)
 * @param {object|null} [params.signer]   audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runImport({ file, mapping = null, grantRegister = null, env = process.env, runGate = true, signer = null }) {
    const csvPath = resolveImportPath(file, { env });
    const text = readFileSync(csvPath, 'utf8');
    const { headers, sample } = readSample(text);

    // Propose-only: read and suggest, write nothing. If a grant register was
    // named without a confirmed mapping, propose its mapping too.
    if (!mapping) {
        const proposal = proposeMapping(headers, sample);
        let grantProposal = null;
        if (grantRegister?.file && !grantRegister.mapping) {
            const gPath = resolveImportPath(grantRegister.file, { env });
            const { headers: gHeaders, sample: gSample } = readSample(readFileSync(gPath, 'utf8'));
            grantProposal = {
                file: basename(grantRegister.file),
                headers: gHeaders,
                ...proposeMapping(gHeaders, gSample, CANONICAL_GRANT_FIELDS),
            };
        }
        return { stage: 'propose', csvPath, file: basename(file), headers, ...proposal, grantRegister: grantProposal };
    }

    // A grant register confirmed alongside the expenditures is resolved (and
    // path-confined) up front, so a bad register name fails before any write.
    const registerPath = grantRegister?.file ? resolveImportPath(grantRegister.file, { env }) : null;
    if (registerPath && !grantRegister.mapping) {
        throw new ImportError(`a grant register (${basename(grantRegister.file)}) was given without a confirmed --grants-map; run without --map to see a proposed grant mapping.`);
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

    // The Civic-Chain ruleset in force for this schema: its content hash and
    // signature status are recorded on the import entry and reported in results.
    const ruleset = loadRuleset(MUNICIPAL_RULESET_PATH);
    const rulesetMeta = {
        name: ruleset.name,
        version: ruleset.version,
        contentHash: ruleset.contentHash,
        status: ruleset.signature.status,
        signedBy: ruleset.signature.signedBy,
    };

    // Record the import as the first audit entry: the source bytes' hash is the
    // anchor every later figure ties back to (dataHash), under a named, signed
    // ruleset version (rulesetHash).
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
            ruleset: rulesetMeta,
            rulesetHash: rulesetMeta.contentHash,
            dataHash: built.sourceFileSha256,
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
        ruleset: rulesetMeta,
        audit: { seq: importEntry.seq, hash: importEntry.hash, signed: Boolean(importEntry.signature) },
        grantRegister: null,
        gate: null,
        config: null,
    };

    // Second import: apply the grant register onto the just-built ledger and
    // record it as its own audit entry, so grant-status measures real awards.
    if (registerPath) {
        const applied = applyGrantRegisterToLedger({ csvPath: registerPath, mapping: grantRegister.mapping, dbPath: paths.dbPath });
        const grantEntry = append(
            {
                kind: 'import-grants',
                question: `Applied a grant register of ${applied.counts.grants} grant(s) from ${basename(grantRegister.file)} (${applied.counts.updated} updated, ${applied.counts.inserted} inserted)`,
                sourceFile: basename(grantRegister.file),
                sourceFileSha256: applied.sourceFileSha256,
                byteLength: applied.byteLength,
                rowCount: applied.counts.grants,
                counts: applied.counts,
                mapping: grantRegister.mapping,
                canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
                ruleset: rulesetMeta,
                rulesetHash: rulesetMeta.contentHash,
                dataHash: applied.sourceFileSha256,
                tables: ['grants'],
                resultHash: applied.sourceFileSha256,
                llmScope: 'none',
                dataModified: true,
                at: new Date().toISOString(),
            },
            { path: paths.logPath, complianceTags: ['import'], signer },
        );
        result.grantRegister = {
            file: basename(grantRegister.file),
            sourceFileSha256: applied.sourceFileSha256,
            byteLength: applied.byteLength,
            counts: applied.counts,
            mapping: grantRegister.mapping,
            audit: { seq: grantEntry.seq, hash: grantEntry.hash, signed: Boolean(grantEntry.signature) },
        };
    }

    if (runGate) result.gate = await runGateQueries(paths, signer, { rulesetPath: MUNICIPAL_RULESET_PATH, dataHash: built.sourceFileSha256 });

    result.config = {
        mcpServers: {
            'civic-chain-auditor': {
                command: 'npx',
                args: ['-y', PKG, 'mcp'],
                env: {
                    CIVIC_DB_PATH: paths.dbPath,
                    CIVIC_ALLOWLIST_PATH: paths.allowlistPath,
                    CIVIC_RULESET_PATH: MUNICIPAL_RULESET_PATH,
                    CIVIC_DATA_HASH: built.sourceFileSha256,
                },
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
 * @param {object} [options]
 * @param {string} [options.rulesetPath] the Civic-Chain ruleset to run under
 * @param {string} [options.dataHash]    the data fingerprint to record (the CSV's SHA-256)
 * @returns {Promise<{ ok: boolean, queries: object[] }>}
 */
export async function runGateQueries(paths, signer = null, { rulesetPath = null, dataHash = null } = {}) {
    const { loadCustomWarehouse } = await import('./custom.js');
    const { guard } = await import('./guard.js');
    const { runNamedQuery } = await import('./named-run.js');
    const warehouse = loadCustomWarehouse({
        env: {
            CIVIC_DB_PATH: paths.dbPath,
            CIVIC_ALLOWLIST_PATH: paths.allowlistPath,
            CIVIC_AUDIT_LOG: paths.logPath,
            ...(rulesetPath ? { CIVIC_RULESET_PATH: rulesetPath } : {}),
            ...(dataHash ? { CIVIC_DATA_HASH: dataHash } : {}),
        },
    });
    const queries = [];
    for (const name of GATE_QUERIES) {
        const out = runNamedQuery(warehouse, name, {}, { guard, signer });
        queries.push({ name, rowCount: out.rows.length, integrity: out.integrity, findings: out.findings });
    }
    return { ok: queries.every((q) => q.integrity === 'pass'), queries };
}

// ── formatting ──────────────────────────────────────────────────────────────

/** Render one proposal block (fields, unused columns, the mapping to confirm). */
function formatProposalBlock(r, { mapFlag }) {
    const lines = [];
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
        lines.push(`  ✖ Required field(s) not mapped: ${r.missingRequired.join(', ')}. Supply a mapping with ${mapFlag}.`);
    } else {
        const mapping = Object.fromEntries(r.fields.filter((f) => f.header).map((f) => [f.field, f.header]));
        lines.push(`  To import with this mapping, save it and pass it with ${mapFlag}:`);
        lines.push('');
        lines.push(JSON.stringify(mapping, null, 2));
    }
    return lines;
}

/** Format a propose-stage result for the terminal. */
function formatPropose(r) {
    const lines = [`Proposed mapping for ${r.file} (nothing written yet)`, ''];
    lines.push(...formatProposalBlock(r, { mapFlag: '--map' }));
    if (r.grantRegister) {
        lines.push('');
        lines.push(`Proposed grant-register mapping for ${r.grantRegister.file} (nothing written yet)`);
        lines.push('');
        lines.push(...formatProposalBlock(r.grantRegister, { mapFlag: '--grants-map' }));
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
        `  ruleset        : ${r.ruleset.name}/${r.ruleset.version} (${r.ruleset.status}${r.ruleset.signedBy ? `, key ${r.ruleset.signedBy}` : ''})`,
        `  ledger         : ${r.paths.dbPath}`,
        `  mapping saved  : ${r.paths.mappingPath}`,
        `  audit entry    : #${r.audit.seq} ${r.audit.hash.slice(0, 16)}… (${r.audit.signed ? 'signed' : 'unsigned'})`,
    ];
    if (r.grantRegister) {
        const g = r.grantRegister;
        lines.push('');
        lines.push(`  Grant register ${g.file}: ${g.counts.grants} grant(s) (${g.counts.updated} updated, ${g.counts.inserted} inserted)`);
        lines.push(`    source SHA-256 : ${g.sourceFileSha256}`);
        lines.push(`    audit entry    : #${g.audit.seq} ${g.audit.hash.slice(0, 16)}… (${g.audit.signed ? 'signed' : 'unsigned'})`);
    }
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

/**
 * `cc-auditor import --pack iolta`: bring a law firm's own client-trust (IOLTA)
 * export into the engine.
 *
 * This is the IOLTA counterpart to runImport (import.js, municipal). The flow is
 * the same two steps on purpose: with no `--map`, the engine reads the trust
 * journal's headers (and a sample of rows to confirm types) and *proposes* a
 * column mapping onto the canonical IOLTA schema, writing nothing; with `--map`
 * it builds the ledger, records the source file's SHA-256 as the first audit
 * entry, optionally applies the bank-snapshots and fee-invoices registers (each
 * its own source-hashed entry), and runs the five iolta-v1 controls as the gate.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened (paths.js, resolveImportPath). Client PII never enters: the
 * canonical IOLTA schema has no column that could hold a name, email or address.
 */

import { basename } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolveImportPath, importedLedgerPaths, ensureParent, assetPath } from './paths.js';
import {
    buildIoltaLedgerFromCsv,
    applyBankSnapshotsToLedger,
    applyFeeInvoicesToLedger,
    proposeMapping,
    IOLTA_SCHEMA_VERSION,
    CANONICAL_IOLTA_JOURNAL_FIELDS,
    CANONICAL_IOLTA_BANK_FIELDS,
    CANONICAL_IOLTA_INVOICE_FIELDS,
    ImportError,
} from './import-iolta.js';
import { parseCsv } from './import-csv.js';
import { loadRuleset } from './ruleset.js';
import { runGateQueries } from './import.js';

const PKG = '@civic-chain/auditor';

/** The bundled Civic-Chain ruleset for the canonical IOLTA schema. */
export const IOLTA_RULESET_PATH = assetPath('iolta', 'ruleset.iolta-v1.json');

/** The five named queries the IOLTA import gate re-runs. */
export const IOLTA_GATE_QUERIES = Object.freeze([
    'three-way-reconciliation',
    'negative-client-balances',
    'unsupported-fee-transfers',
    'firm-funds-in-trust',
    'dormant-balances',
]);

/** Read a sample of a CSV (headers + up to `n` rows) without a full parse cost on huge files. */
function readSample(text, n = 25) {
    const { headers, rows } = parseCsv(text);
    return { headers, rows, sample: rows.slice(0, n) };
}

/**
 * Run an IOLTA import, or propose mappings when none is confirmed yet.
 *
 * @param {object} params
 * @param {string} params.file           trust-journal CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed journal mapping; null = propose only
 * @param {{ file: string, mapping: (Record<string,string>|null) }|null} [params.bankSnapshots]
 *   an optional bank-snapshots file applied after the journal import
 * @param {{ file: string, mapping: (Record<string,string>|null) }|null} [params.feeInvoices]
 *   an optional fee-invoices file applied after the bank snapshots
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate]      after import, run the five named queries (default true)
 * @param {object|null} [params.signer]   audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatIoltaImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runIoltaImport({ file, mapping = null, bankSnapshots = null, feeInvoices = null, env = process.env, runGate = true, signer = null }) {
    const csvPath = resolveImportPath(file, { env });
    const text = readFileSync(csvPath, 'utf8');
    const { headers, sample } = readSample(text);

    // Propose-only: read and suggest, write nothing. Propose the optional
    // registers' mappings too when they were named without a confirmed mapping.
    if (!mapping) {
        const proposal = proposeMapping(headers, sample, CANONICAL_IOLTA_JOURNAL_FIELDS);
        let bankProposal = null;
        if (bankSnapshots?.file && !bankSnapshots.mapping) {
            const bPath = resolveImportPath(bankSnapshots.file, { env });
            const { headers: bHeaders, sample: bSample } = readSample(readFileSync(bPath, 'utf8'));
            bankProposal = { file: basename(bankSnapshots.file), headers: bHeaders, ...proposeMapping(bHeaders, bSample, CANONICAL_IOLTA_BANK_FIELDS) };
        }
        let invoiceProposal = null;
        if (feeInvoices?.file && !feeInvoices.mapping) {
            const iPath = resolveImportPath(feeInvoices.file, { env });
            const { headers: iHeaders, sample: iSample } = readSample(readFileSync(iPath, 'utf8'));
            invoiceProposal = { file: basename(feeInvoices.file), headers: iHeaders, ...proposeMapping(iHeaders, iSample, CANONICAL_IOLTA_INVOICE_FIELDS) };
        }
        return { stage: 'propose', pack: 'iolta', csvPath, file: basename(file), headers, ...proposal, bankSnapshots: bankProposal, feeInvoices: invoiceProposal };
    }

    // A register confirmed alongside the journal is resolved (and path-confined)
    // up front, so a bad register name fails before any write.
    const bankPath = bankSnapshots?.file ? resolveImportPath(bankSnapshots.file, { env }) : null;
    if (bankPath && !bankSnapshots.mapping) {
        throw new ImportError(`a bank-snapshots file (${basename(bankSnapshots.file)}) was given without a confirmed --bank-map; run without --map to see a proposed bank mapping.`);
    }
    const invoicePath = feeInvoices?.file ? resolveImportPath(feeInvoices.file, { env }) : null;
    if (invoicePath && !feeInvoices.mapping) {
        throw new ImportError(`a fee-invoices file (${basename(feeInvoices.file)}) was given without a confirmed --invoices-map; run without --map to see a proposed invoices mapping.`);
    }

    // Confirmed: build the ledger into a fresh per-import subtree of the data
    // directory. A fresh chain per import keeps result hashes reproducible.
    const paths = importedLedgerPaths(basename(file), { env });
    rmSync(paths.logPath, { force: true });

    const built = buildIoltaLedgerFromCsv({
        csvPath,
        mapping,
        dbPath: paths.dbPath,
        allowlistPath: paths.allowlistPath,
    });

    // Persist the confirmed mapping (reviewable, and re-usable with --map).
    ensureParent(paths.mappingPath);
    writeFileSync(
        paths.mappingPath,
        JSON.stringify({ pack: 'iolta', canonicalSchemaVersion: IOLTA_SCHEMA_VERSION, source: basename(file), mapping: built.mapping }, null, 2),
    );

    const ruleset = loadRuleset(IOLTA_RULESET_PATH);
    const rulesetMeta = {
        name: ruleset.name,
        version: ruleset.version,
        contentHash: ruleset.contentHash,
        status: ruleset.signature.status,
        signedBy: ruleset.signature.signedBy,
    };

    // Record the import as the first audit entry: the source bytes' hash is the
    // anchor every later figure ties back to, under a named, signed ruleset.
    const { append } = await import('./audit.js');
    const importEntry = append(
        {
            kind: 'import',
            question: `Imported ${built.counts.rowCount} trust-journal entr(y/ies) from ${basename(file)}`,
            sourceFile: basename(file),
            sourceFileSha256: built.sourceFileSha256,
            byteLength: built.byteLength,
            rowCount: built.counts.rowCount,
            counts: built.counts,
            mapping: built.mapping,
            canonicalSchemaVersion: IOLTA_SCHEMA_VERSION,
            ruleset: rulesetMeta,
            rulesetHash: rulesetMeta.contentHash,
            dataHash: built.sourceFileSha256,
            tables: ['trust_journal'],
            resultHash: built.sourceFileSha256,
            llmScope: 'none',
            dataModified: true,
            at: new Date().toISOString(),
        },
        { path: paths.logPath, complianceTags: ['import'], signer },
    );

    const result = {
        stage: 'imported',
        pack: 'iolta',
        file: basename(file),
        csvPath,
        paths,
        counts: built.counts,
        sourceFileSha256: built.sourceFileSha256,
        byteLength: built.byteLength,
        mapping: built.mapping,
        canonicalSchemaVersion: IOLTA_SCHEMA_VERSION,
        ruleset: rulesetMeta,
        audit: { seq: importEntry.seq, hash: importEntry.hash, signed: Boolean(importEntry.signature) },
        bankSnapshots: null,
        feeInvoices: null,
        gate: null,
        config: null,
    };

    // Second file: bank snapshots, so three-way-reconciliation has an adjusted
    // bank balance to tie to. Its own source-hashed audit entry.
    if (bankPath) {
        const applied = applyBankSnapshotsToLedger({ csvPath: bankPath, mapping: bankSnapshots.mapping, dbPath: paths.dbPath });
        const entry = append(
            {
                kind: 'import-bank-snapshots',
                question: `Applied ${applied.counts.snapshots} bank snapshot(s) from ${basename(bankSnapshots.file)}`,
                sourceFile: basename(bankSnapshots.file),
                sourceFileSha256: applied.sourceFileSha256,
                byteLength: applied.byteLength,
                rowCount: applied.counts.snapshots,
                counts: applied.counts,
                mapping: bankSnapshots.mapping,
                canonicalSchemaVersion: IOLTA_SCHEMA_VERSION,
                ruleset: rulesetMeta,
                rulesetHash: rulesetMeta.contentHash,
                dataHash: applied.sourceFileSha256,
                tables: ['trust_bank_snapshots'],
                resultHash: applied.sourceFileSha256,
                llmScope: 'none',
                dataModified: true,
                at: new Date().toISOString(),
            },
            { path: paths.logPath, complianceTags: ['import'], signer },
        );
        result.bankSnapshots = {
            file: basename(bankSnapshots.file),
            sourceFileSha256: applied.sourceFileSha256,
            byteLength: applied.byteLength,
            counts: applied.counts,
            mapping: bankSnapshots.mapping,
            audit: { seq: entry.seq, hash: entry.hash, signed: Boolean(entry.signature) },
        };
    }

    // Third file: fee invoices, so unsupported-fee-transfers can confirm each
    // earned-fee transfer against a real invoice. Its own source-hashed entry.
    if (invoicePath) {
        const applied = applyFeeInvoicesToLedger({ csvPath: invoicePath, mapping: feeInvoices.mapping, dbPath: paths.dbPath });
        const entry = append(
            {
                kind: 'import-fee-invoices',
                question: `Applied ${applied.counts.invoices} fee invoice(s) from ${basename(feeInvoices.file)}`,
                sourceFile: basename(feeInvoices.file),
                sourceFileSha256: applied.sourceFileSha256,
                byteLength: applied.byteLength,
                rowCount: applied.counts.invoices,
                counts: applied.counts,
                mapping: feeInvoices.mapping,
                canonicalSchemaVersion: IOLTA_SCHEMA_VERSION,
                ruleset: rulesetMeta,
                rulesetHash: rulesetMeta.contentHash,
                dataHash: applied.sourceFileSha256,
                tables: ['fee_invoices'],
                resultHash: applied.sourceFileSha256,
                llmScope: 'none',
                dataModified: true,
                at: new Date().toISOString(),
            },
            { path: paths.logPath, complianceTags: ['import'], signer },
        );
        result.feeInvoices = {
            file: basename(feeInvoices.file),
            sourceFileSha256: applied.sourceFileSha256,
            byteLength: applied.byteLength,
            counts: applied.counts,
            mapping: feeInvoices.mapping,
            audit: { seq: entry.seq, hash: entry.hash, signed: Boolean(entry.signature) },
        };
    }

    if (runGate) {
        result.gate = await runGateQueries(paths, signer, {
            rulesetPath: IOLTA_RULESET_PATH,
            dataHash: built.sourceFileSha256,
            queries: IOLTA_GATE_QUERIES,
        });
    }

    result.config = {
        mcpServers: {
            'civic-chain-auditor': {
                command: 'npx',
                args: ['-y', PKG, 'mcp'],
                env: {
                    CIVIC_DB_PATH: paths.dbPath,
                    CIVIC_ALLOWLIST_PATH: paths.allowlistPath,
                    CIVIC_RULESET_PATH: IOLTA_RULESET_PATH,
                    CIVIC_DATA_HASH: built.sourceFileSha256,
                },
            },
        },
    };
    return result;
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

/** Format a propose-stage IOLTA result for the terminal. */
function formatPropose(r) {
    const lines = [`Proposed IOLTA trust-journal mapping for ${r.file} (nothing written yet)`, ''];
    lines.push(...formatProposalBlock(r, { mapFlag: '--map' }));
    if (r.bankSnapshots) {
        lines.push('', `Proposed bank-snapshots mapping for ${r.bankSnapshots.file} (nothing written yet)`, '');
        lines.push(...formatProposalBlock(r.bankSnapshots, { mapFlag: '--bank-map' }));
    }
    if (r.feeInvoices) {
        lines.push('', `Proposed fee-invoices mapping for ${r.feeInvoices.file} (nothing written yet)`, '');
        lines.push(...formatProposalBlock(r.feeInvoices, { mapFlag: '--invoices-map' }));
    }
    return lines.join('\n');
}

/** Format an imported-stage IOLTA result for the terminal. */
function formatImported(r) {
    const c = r.counts;
    const lines = [
        `Imported ${r.file}: ${c.rowCount} trust-journal entr(y/ies) across ${c.clients} client ledger(s)`,
        '',
        `  source SHA-256 : ${r.sourceFileSha256}`,
        `  bytes          : ${r.byteLength}`,
        `  schema         : ${r.canonicalSchemaVersion}`,
        `  ruleset        : ${r.ruleset.name}/${r.ruleset.version} (${r.ruleset.status}${r.ruleset.signedBy ? `, key ${r.ruleset.signedBy}` : ''})`,
        `  ledger         : ${r.paths.dbPath}`,
        `  mapping saved  : ${r.paths.mappingPath}`,
        `  audit entry    : #${r.audit.seq} ${r.audit.hash.slice(0, 16)}… (${r.audit.signed ? 'signed' : 'unsigned'})`,
    ];
    if (r.bankSnapshots) {
        const b = r.bankSnapshots;
        lines.push('', `  Bank snapshots ${b.file}: ${b.counts.snapshots} snapshot(s)`);
        lines.push(`    source SHA-256 : ${b.sourceFileSha256}`);
        lines.push(`    audit entry    : #${b.audit.seq} ${b.audit.hash.slice(0, 16)}… (${b.audit.signed ? 'signed' : 'unsigned'})`);
    }
    if (r.feeInvoices) {
        const i = r.feeInvoices;
        lines.push('', `  Fee invoices ${i.file}: ${i.counts.invoices} invoice(s)`);
        lines.push(`    source SHA-256 : ${i.sourceFileSha256}`);
        lines.push(`    audit entry    : #${i.audit.seq} ${i.audit.hash.slice(0, 16)}… (${i.audit.signed ? 'signed' : 'unsigned'})`);
    }
    if (r.gate) {
        lines.push('', `  Named-query gate: ${r.gate.ok ? 'clean integrity on all five' : 'INTEGRITY FLAGGED'}`);
        for (const q of r.gate.queries) {
            lines.push(`    ${q.name.padEnd(26)} ${q.rowCount} row(s)  integrity ${q.integrity}  ${q.findings} finding(s)`);
        }
    }
    if (r.config) {
        lines.push('', 'Point your MCP client at the imported ledger (paste into .mcp.json):', '');
        lines.push(JSON.stringify(r.config, null, 2));
    }
    return lines.join('\n');
}

/** Format any IOLTA import result for the terminal. */
export function formatIoltaImport(r) {
    if (r.stage === 'propose') return formatPropose(r);
    if (r.stage === 'imported') return formatImported(r);
    return JSON.stringify(r, null, 2);
}

export { ImportError };

/**
 * Config-driven CSV import engine.
 *
 * `runImport` (municipal) and `runIoltaImport` were two near-identical runners:
 * same two-step propose→confirm flow, same per-import audit chain, same gate, the
 * same companion-file pattern — differing only in *data* (schema version, ruleset,
 * gate queries, the primary build fn + its field spec, and an ordered list of
 * optional companion files). This module is that shared flow, parameterised by a
 * pack *spec* (see import-spec.js). A new pack's M4 import is a spec entry plus its
 * irreducible schema/DDL + build/apply fns (import-<pack>.js) — no new runner.
 *
 * The flow is two steps on purpose. First, with no mapping, the engine reads each
 * file's headers (and a sample of rows to confirm types) and *proposes* a column
 * mapping onto that pack's canonical schema; it writes nothing. The operator
 * reviews, adjusts, and re-runs with a confirmed mapping. Only a confirmed mapping
 * is ever written; it is saved beside the ledger and recorded in the audit log, so
 * every figure the gate queries later produce ties back to the exact bytes that
 * were imported and the exact mapping that was confirmed.
 *
 * Local only: no network, no credential. Files are read by name from the folder
 * named in CIVIC_IMPORT_DIR; a name that escapes that folder is refused before
 * anything is opened (paths.js, resolveImportPath).
 */

import { basename } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolveImportPath, importedLedgerPaths, ensureParent } from './paths.js';
import { parseCsv, proposeMapping, ImportError } from './import-csv.js';
import { loadRuleset } from './ruleset.js';

const PKG = '@civic-chain/auditor';

/** The default gate queries (the municipal three) when a caller names none. */
export const GATE_QUERIES = ['grant-status', 'spending-by-vendor', 'budget-variance'];

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const numberWord = (n) => NUMBER_WORDS[n] ?? String(n);

/** Read a sample of a CSV (headers + up to `n` rows) without a full parse cost on huge files. */
function readSample(text, n = 25) {
    const { headers, rows } = parseCsv(text);
    return { headers, rows, sample: rows.slice(0, n) };
}

/**
 * Run a pack's import, or propose mappings when none is confirmed yet.
 *
 * @param {import('./import-spec.js').ImportSpec} spec
 * @param {object} params
 * @param {string} params.file   primary CSV file name within CIVIC_IMPORT_DIR
 * @param {Record<string,string>|null} [params.mapping] confirmed primary mapping; null = propose only
 * @param {Array<{file: string, mapping: (Record<string,string>|null)}|null>} [params.companions]
 *   one entry per `spec.companions`, in order (null = not supplied)
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {boolean} [params.runGate] after import, run the gate queries (default true)
 * @param {object|null} [params.signer] audit signer (CLI passes loadSigner())
 * @returns {Promise<object>} structured result; see formatPackImport for the shape consumed
 * @throws {ImportError|Error}
 */
export async function runPackImport(spec, { file, mapping = null, companions = [], env = process.env, runGate = true, signer = null }) {
    const csvPath = resolveImportPath(file, { env });
    const text = readFileSync(csvPath, 'utf8');
    const { headers, sample } = readSample(text);

    // Propose-only: read and suggest, write nothing. Propose each named
    // companion's mapping too when it was given without a confirmed mapping.
    if (!mapping) {
        const proposal = proposeMapping(headers, sample, spec.primary.fields);
        const out = { stage: 'propose', csvPath, file: basename(file), headers, ...proposal };
        if (spec.emitPackField) out.pack = spec.pack;
        spec.companions.forEach((c, i) => {
            const given = companions[i];
            if (given?.file && !given.mapping) {
                const p = resolveImportPath(given.file, { env });
                const { headers: h, sample: s } = readSample(readFileSync(p, 'utf8'));
                out[c.resultKey] = { file: basename(given.file), headers: h, ...proposeMapping(h, s, c.fields) };
            } else {
                out[c.resultKey] = null;
            }
        });
        return out;
    }

    // A companion confirmed alongside the primary file is resolved (and
    // path-confined) up front, so a bad name fails before any write.
    const companionPaths = spec.companions.map((c, i) => {
        const given = companions[i];
        if (!given?.file) return null;
        const p = resolveImportPath(given.file, { env });
        if (!given.mapping) throw new ImportError(c.missingMapError(basename(given.file)));
        return { path: p, mapping: given.mapping, file: basename(given.file), spec: c };
    });

    // Confirmed: build the ledger into a fresh per-import subtree of the data
    // directory. A fresh chain per import keeps result hashes reproducible.
    const paths = importedLedgerPaths(basename(file), { env });
    rmSync(paths.logPath, { force: true });

    const built = spec.primary.build({
        csvPath,
        mapping,
        dbPath: paths.dbPath,
        allowlistPath: paths.allowlistPath,
    });

    // Persist the confirmed mapping (reviewable, and re-usable with --map).
    ensureParent(paths.mappingPath);
    writeFileSync(
        paths.mappingPath,
        JSON.stringify(
            {
                ...(spec.emitPackField ? { pack: spec.pack } : {}),
                canonicalSchemaVersion: spec.schemaVersion,
                source: basename(file),
                mapping: built.mapping,
            },
            null,
            2,
        ),
    );

    // The Civic-Chain ruleset in force for this schema: its content hash and
    // signature status are recorded on the import entry and reported in results.
    const ruleset = loadRuleset(spec.rulesetPath);
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
    const entryMeta = { ruleset: rulesetMeta, rulesetHash: rulesetMeta.contentHash, llmScope: 'none', dataModified: true };
    const importEntry = append(
        {
            kind: 'import',
            question: spec.primary.importQuestion(built.counts, basename(file)),
            sourceFile: basename(file),
            sourceFileSha256: built.sourceFileSha256,
            byteLength: built.byteLength,
            rowCount: built.counts.rowCount,
            counts: built.counts,
            mapping: built.mapping,
            canonicalSchemaVersion: spec.schemaVersion,
            ...entryMeta,
            dataHash: built.sourceFileSha256,
            tables: spec.primary.tables,
            resultHash: built.sourceFileSha256,
            at: new Date().toISOString(),
        },
        { path: paths.logPath, complianceTags: ['import'], signer },
    );

    const result = {
        stage: 'imported',
        ...(spec.emitPackField ? { pack: spec.pack } : {}),
        file: basename(file),
        csvPath,
        paths,
        counts: built.counts,
        sourceFileSha256: built.sourceFileSha256,
        byteLength: built.byteLength,
        mapping: built.mapping,
        canonicalSchemaVersion: spec.schemaVersion,
        ruleset: rulesetMeta,
        audit: { seq: importEntry.seq, hash: importEntry.hash, signed: Boolean(importEntry.signature) },
        gate: null,
        config: null,
    };
    for (const c of spec.companions) result[c.resultKey] = null;

    // Apply each confirmed companion onto the just-built ledger, in order, each
    // recorded as its own source-hashed audit entry (so the controls that read
    // these tables measure real figures, and every figure ties back to bytes).
    for (const cp of companionPaths) {
        if (!cp) continue;
        const applied = cp.spec.apply({ csvPath: cp.path, mapping: cp.mapping, dbPath: paths.dbPath });
        const entry = append(
            {
                kind: cp.spec.kind,
                question: cp.spec.question(applied.counts, cp.file),
                sourceFile: cp.file,
                sourceFileSha256: applied.sourceFileSha256,
                byteLength: applied.byteLength,
                rowCount: cp.spec.rowCount(applied.counts),
                counts: applied.counts,
                mapping: cp.mapping,
                canonicalSchemaVersion: spec.schemaVersion,
                ...entryMeta,
                dataHash: applied.sourceFileSha256,
                tables: cp.spec.tables,
                resultHash: applied.sourceFileSha256,
                at: new Date().toISOString(),
            },
            { path: paths.logPath, complianceTags: ['import'], signer },
        );
        result[cp.spec.resultKey] = {
            file: cp.file,
            sourceFileSha256: applied.sourceFileSha256,
            byteLength: applied.byteLength,
            counts: applied.counts,
            mapping: cp.mapping,
            audit: { seq: entry.seq, hash: entry.hash, signed: Boolean(entry.signature) },
        };
    }

    if (runGate) {
        result.gate = await runGateQueries(paths, signer, {
            rulesetPath: spec.rulesetPath,
            dataHash: built.sourceFileSha256,
            queries: spec.gateQueries,
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
                    CIVIC_RULESET_PATH: spec.rulesetPath,
                    CIVIC_DATA_HASH: built.sourceFileSha256,
                },
            },
        },
    };
    return result;
}

/**
 * Run a pack's gate queries against an imported ledger and report each one's
 * integrity and finding counts. A clean import answers them all with 'pass'.
 *
 * @param {{ dbPath: string, allowlistPath: string, logPath: string }} paths
 * @param {object|null} signer
 * @param {object} [options]
 * @param {string} [options.rulesetPath] the Civic-Chain ruleset to run under
 * @param {string} [options.dataHash]    the data fingerprint to record (the CSV's SHA-256)
 * @param {string[]} [options.queries]   the named queries to run (defaults to the municipal three)
 * @returns {Promise<{ ok: boolean, queries: object[] }>}
 */
export async function runGateQueries(paths, signer = null, { rulesetPath = null, dataHash = null, queries: gateQueries = GATE_QUERIES } = {}) {
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
    for (const name of gateQueries) {
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
function formatPropose(spec, r) {
    const lines = [spec.primary.proposeTitle(r.file), ''];
    lines.push(...formatProposalBlock(r, { mapFlag: '--map' }));
    for (const c of spec.companions) {
        const block = r[c.resultKey];
        if (!block) continue;
        lines.push('', c.proposeTitle(block.file), '');
        lines.push(...formatProposalBlock(block, { mapFlag: c.mapFlag }));
    }
    return lines.join('\n');
}

/** Format an imported-stage result for the terminal. */
function formatImported(spec, r) {
    const c = r.counts;
    const lines = [
        `Imported ${r.file}: ${c.rowCount} ${spec.primary.headerNoun(c)}`,
        '',
        `  source SHA-256 : ${r.sourceFileSha256}`,
        `  bytes          : ${r.byteLength}`,
    ];
    if (spec.primary.derived) lines.push(`  derived        : ${spec.primary.derived(c)}`);
    lines.push(
        `  schema         : ${r.canonicalSchemaVersion}`,
        `  ruleset        : ${r.ruleset.name}/${r.ruleset.version} (${r.ruleset.status}${r.ruleset.signedBy ? `, key ${r.ruleset.signedBy}` : ''})`,
        `  ledger         : ${r.paths.dbPath}`,
        `  mapping saved  : ${r.paths.mappingPath}`,
        `  audit entry    : #${r.audit.seq} ${r.audit.hash.slice(0, 16)}… (${r.audit.signed ? 'signed' : 'unsigned'})`,
    );
    for (const comp of spec.companions) {
        const b = r[comp.resultKey];
        if (!b) continue;
        lines.push('', `  ${comp.summaryLine(b.counts, b.file)}`);
        lines.push(`    source SHA-256 : ${b.sourceFileSha256}`);
        lines.push(`    audit entry    : #${b.audit.seq} ${b.audit.hash.slice(0, 16)}… (${b.audit.signed ? 'signed' : 'unsigned'})`);
    }
    if (r.gate) {
        const word = numberWord(spec.gateQueries.length);
        lines.push('', `  Named-query gate: ${r.gate.ok ? `clean integrity on all ${word}` : 'INTEGRITY FLAGGED'}`);
        const width = Math.max(...r.gate.queries.map((q) => q.name.length)) + 2;
        for (const q of r.gate.queries) {
            lines.push(`    ${q.name.padEnd(width)} ${q.rowCount} row(s)  integrity ${q.integrity}  ${q.findings} finding(s)`);
        }
    }
    if (r.config) {
        lines.push('', 'Point your MCP client at the imported ledger (paste into .mcp.json):', '');
        lines.push(JSON.stringify(r.config, null, 2));
    }
    return lines.join('\n');
}

/** Format any import result for the terminal, under a pack spec. */
export function formatPackImport(spec, r) {
    if (r.stage === 'propose') return formatPropose(spec, r);
    if (r.stage === 'imported') return formatImported(spec, r);
    return JSON.stringify(r, null, 2);
}

export { ImportError };

/**
 * The audit report (R1).
 *
 * The audit chain and the evidence packet already carry everything an auditor
 * needs; what was missing was the one-command, shareable *summary* over a whole
 * log: every attested figure, the ruleset that governed it, the data it ran
 * against, and whether the chain is intact, on one page a reader can skim and a
 * stranger can still check. This module is that renderer. It adds no new
 * provenance; it reads what the entries already record (resultHash, rulesetHash,
 * dataHash, the ruleset's name/version/signature status, named-query integrity
 * and findings) and the chain-verification result, and lays them out.
 *
 * Pure: it takes the entries and the integrity result as inputs and returns
 * strings, with no `node:` imports, so the same renderer runs in the browser and
 * the CLI. bin/auditor.js supplies the file-backed log and the verification;
 * evidence.js is the equivalent split for a single-result packet.
 *
 * Claim discipline (same as the evidence packet): a report is *evidence*, not a
 * certificate. It states plainly that it is produced by software and is not a
 * CPA opinion, and when it is run over the bundled demo ledger rather than an
 * imported real CSV it says so, so a synthetic figure is never mistaken for a
 * real one.
 */

/** This report is evidence an auditor can recompute, not an attestation. */
export const CPA_DISCLAIMER =
    'This report is produced by software. It reproduces figures from the data and ' +
    'records their provenance; it is not an audit opinion and is not a substitute ' +
    'for one. A SOC 2 or financial-statement opinion is an attestation a licensed ' +
    'CPA firm issues about an organisation; this is evidence such work can rest on.';

/** Shown when the report covers the bundled demo ledger, not an imported CSV. */
export const SYNTHETIC_NOTICE =
    'The data behind this report is the bundled, synthetic demonstration ledger. ' +
    'The figures are internally consistent but describe no real organisation. No ' +
    'imported source file (and so no source data hash) is recorded on these entries.';

/** A short, human label for an entry, and what produced it. */
function describeEntry(entry) {
    if (entry.namedQuery) return { label: entry.namedQuery, kind: 'named query' };
    if (entry.agentSql) return { label: entry.question, kind: 'agent SQL' };
    return { label: entry.question ?? '(unlabelled)', kind: 'query' };
}

/** Distinct, order-preserving values of a key across entries, dropping null/undefined. */
function distinct(values) {
    const seen = new Set();
    const out = [];
    for (const v of values) {
        if (v == null) continue;
        const key = typeof v === 'object' ? JSON.stringify(v) : v;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}

/**
 * Build the report object from a log and its verification result. Pure.
 *
 * @param {object} params
 * @param {object[]} params.entries        the audit log, in order
 * @param {{ ok: boolean, entries: number, brokenAt: number|null, reason: string|null }} params.integrity
 * @param {string|null} [params.warehouse] the warehouse this log belongs to
 * @param {string} [params.generatedAt]    ISO timestamp (injectable for deterministic tests)
 * @param {boolean|null} [params.synthetic] force the synthetic/real flag; by default
 *   it is inferred as "synthetic" when no entry records a source data hash
 * @returns {object}
 */
export function buildAuditReport({ entries, integrity, warehouse = null, generatedAt = new Date().toISOString(), synthetic = null }) {
    const signedEntries = entries.filter((e) => e.signature).length;
    const dataHashes = distinct(entries.map((e) => e.dataHash));
    const inferredSynthetic = dataHashes.length === 0;

    const rulesets = distinct(
        entries
            .filter((e) => e.ruleset)
            .map((e) => ({
                name: e.ruleset.name ?? null,
                version: e.ruleset.version ?? null,
                status: e.ruleset.status ?? null,
                rulesetHash: e.rulesetHash ?? e.ruleset.contentHash ?? null,
            })),
    );

    // Findings and integrity flags live on named-query entries; summarise them.
    const named = entries.filter((e) => typeof e.findings === 'number' || e.integrity);
    const totalFindings = named.reduce((sum, e) => sum + (e.findings ?? 0), 0);
    const flagged = named.filter((e) => e.integrity && e.integrity !== 'pass').length;

    return {
        kind: 'civic-chain.audit-report',
        version: 1,
        generatedAt,
        warehouse,
        synthetic: synthetic ?? inferredSynthetic,
        chain: {
            ok: integrity.ok,
            entries: integrity.entries,
            brokenAt: integrity.brokenAt,
            reason: integrity.reason,
            signedEntries,
        },
        summary: {
            attestations: entries.length,
            findings: totalFindings,
            integrityFlags: flagged,
        },
        rulesets,
        dataHashes,
        entries: entries.map((entry) => {
            const { label, kind } = describeEntry(entry);
            return {
                seq: entry.seq,
                at: entry.at ?? null,
                kind,
                label,
                rowCount: entry.rowCount ?? 0,
                resultHash: entry.resultHash ?? null,
                integrity: entry.integrity ?? null,
                findings: typeof entry.findings === 'number' ? entry.findings : null,
                tables: entry.tables ?? [],
                tags: entry.complianceTags ?? [],
                signed: Boolean(entry.signature),
                signingKeyId: entry.signingKeyId ?? null,
                rulesetHash: entry.rulesetHash ?? null,
                dataHash: entry.dataHash ?? null,
            };
        }),
    };
}

/** The ruleset lines shared by both renderers. */
function rulesetLines(rulesets) {
    if (rulesets.length === 0) return ['(no signed ruleset recorded; queries were buyer-defined or pre-ruleset)'];
    return rulesets.map(
        (r) =>
            `${r.name ?? '(unnamed)'} v${r.version ?? '?'} — ${r.status ?? 'unknown'} · hash ${String(r.rulesetHash ?? '').slice(0, 16)}…`,
    );
}

/**
 * Render the report as Markdown. Deterministic given the report object.
 *
 * @param {object} report a buildAuditReport() result
 * @returns {string}
 */
export function renderReportMarkdown(report) {
    const c = report.chain;
    const chainLine = c.ok ? `INTACT (${c.entries} entries` : `BROKEN at entry ${c.brokenAt}`;
    const chainStatus = c.ok
        ? `${chainLine}, ${c.signedEntries}/${c.entries} signed)`
        : `${chainLine}: ${c.reason}`;

    const rows = report.entries
        .map(
            (e) =>
                `| ${e.seq} | ${e.kind} | ${mdEscape(e.label)} | ${e.rowCount} | ${e.integrity ?? '—'} | ${e.findings ?? '—'} | \`${String(e.resultHash ?? '').slice(0, 16)}…\` |`,
        )
        .join('\n');

    const dataLine = report.dataHashes.length
        ? report.dataHashes.map((h) => `\`${h}\``).join(', ')
        : 'none recorded (see notice below)';

    return `# Audit report${report.warehouse ? ` · ${report.warehouse}` : ''}

**Generated:** ${report.generatedAt}
**Audit chain:** ${chainStatus}
**Attestations:** ${report.summary.attestations} · **findings:** ${report.summary.findings} · **integrity flags:** ${report.summary.integrityFlags}

## Ruleset

${rulesetLines(report.rulesets).map((l) => `- ${l}`).join('\n')}

## Source data

- Data hash(es): ${dataLine}
${report.synthetic ? `\n> ${SYNTHETIC_NOTICE}\n` : ''}
## Attestations

| # | Kind | Figure / query | Rows | Integrity | Findings | Result hash |
|---|------|----------------|------|-----------|----------|-------------|
${rows || '| — | — | (no entries) | — | — | — | — |'}

## Chain verification

${c.ok
    ? 'The hash chain verifies: every entry links to the one before it and none has been altered since it was written.'
    : `The chain is broken at entry ${c.brokenAt}: ${c.reason}. Treat every figure after that point as unverified.`}

Recompute independently: for any row, re-run its SQL against the same data and confirm the result hash; walk the chain and confirm each entry's \`prevHash\` and recomputed hash. \`cc-auditor audit\` and the exported audit package (\`cc-auditor audit --export\`) perform the full check.

## Disclaimer

${CPA_DISCLAIMER}
`;
}

/** Escape the few characters that would break a Markdown table cell. */
function mdEscape(text) {
    return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Escape HTML text content. */
function htmlEscape(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Render the report as a self-contained, print-to-PDF HTML document. Inline CSS
 * only, no external assets, so the browser (or a headless print) turns it into a
 * PDF with no dependency pulled into the engine. Deterministic given the report.
 *
 * @param {object} report a buildAuditReport() result
 * @returns {string}
 */
export function renderReportHtml(report) {
    const c = report.chain;
    const chainStatus = c.ok
        ? `INTACT — ${c.entries} entries, ${c.signedEntries}/${c.entries} signed`
        : `BROKEN at entry ${c.brokenAt}: ${htmlEscape(c.reason)}`;

    const rows = report.entries
        .map(
            (e) => `<tr>
        <td>${e.seq}</td>
        <td>${htmlEscape(e.kind)}</td>
        <td>${htmlEscape(e.label)}</td>
        <td class="num">${e.rowCount}</td>
        <td>${htmlEscape(e.integrity ?? '—')}</td>
        <td class="num">${e.findings ?? '—'}</td>
        <td class="mono">${htmlEscape(String(e.resultHash ?? '').slice(0, 16))}…</td>
      </tr>`,
        )
        .join('\n');

    const rulesetHtml = rulesetLines(report.rulesets)
        .map((l) => `<li>${htmlEscape(l)}</li>`)
        .join('\n');

    const dataHtml = report.dataHashes.length
        ? report.dataHashes.map((h) => `<code>${htmlEscape(h)}</code>`).join(', ')
        : 'none recorded (see notice)';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Audit report${report.warehouse ? ` · ${htmlEscape(report.warehouse)}` : ''}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; color: #1a1a1a; max-width: 52rem; margin: 2rem auto; padding: 0 1.5rem; }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; }
  .meta { color: #555; }
  .status { font-weight: 600; }
  .ok { color: #1a7f37; }
  .broken { color: #b42318; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #eee; vertical-align: top; }
  th { border-bottom: 2px solid #ccc; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono, code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  .notice { background: #fff8e1; border: 1px solid #f0d58c; border-radius: 6px; padding: 0.75rem 1rem; }
  .disclaimer { color: #555; font-size: 12.5px; border-top: 1px solid #ddd; margin-top: 2rem; padding-top: 1rem; }
  @media print { body { margin: 0; max-width: none; } h2 { page-break-after: avoid; } tr { page-break-inside: avoid; } }
</style>
</head>
<body>
<h1>Audit report${report.warehouse ? ` · ${htmlEscape(report.warehouse)}` : ''}</h1>
<p class="meta">Generated ${htmlEscape(report.generatedAt)}</p>
<p class="status">Audit chain: <span class="${c.ok ? 'ok' : 'broken'}">${chainStatus}</span></p>
<p>Attestations: ${report.summary.attestations} · findings: ${report.summary.findings} · integrity flags: ${report.summary.integrityFlags}</p>

<h2>Ruleset</h2>
<ul>${rulesetHtml}</ul>

<h2>Source data</h2>
<p>Data hash(es): ${dataHtml}</p>
${report.synthetic ? `<p class="notice">${htmlEscape(SYNTHETIC_NOTICE)}</p>` : ''}

<h2>Attestations</h2>
<table>
  <thead><tr><th>#</th><th>Kind</th><th>Figure / query</th><th>Rows</th><th>Integrity</th><th>Findings</th><th>Result hash</th></tr></thead>
  <tbody>
${rows || '<tr><td colspan="7">(no entries)</td></tr>'}
  </tbody>
</table>

<h2>Chain verification</h2>
<p>${c.ok
    ? 'The hash chain verifies: every entry links to the one before it and none has been altered since it was written.'
    : `The chain is broken at entry ${c.brokenAt}: ${htmlEscape(c.reason)}. Treat every figure after that point as unverified.`}</p>
<p>Recompute independently: for any row, re-run its SQL against the same data and confirm the result hash; walk the chain and confirm each entry's <code>prevHash</code> and recomputed hash. <code>cc-auditor audit --export</code> performs the full check.</p>

<p class="disclaimer">${htmlEscape(CPA_DISCLAIMER)}</p>
</body>
</html>
`;
}

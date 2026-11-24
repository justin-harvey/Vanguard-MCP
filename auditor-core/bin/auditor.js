#!/usr/bin/env node
/**
 * cc-auditor, command line for the Civic-Chain Grant & Budget Auditor engine.
 *
 *   cc-auditor seed                        build the demo warehouse
 *   cc-auditor ask "question"              answer a question, record the lineage
 *   cc-auditor audit                       verify the chain and show the log
 *   cc-auditor audit --export out.json     write the audit package
 *   cc-auditor report --out report.md      write a shareable audit report (.md|.html)
 *   cc-auditor explain "SELECT ..."        run the guard against SQL, no model call
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { seed, ensureSeeded } from '../src/db.js';
import { guard, SqlRejected } from '../src/guard.js';
import { ask } from '../src/ask.js';
import { verify, readLog, exportPackage, headHash, DEFAULT_LOG_PATH } from '../src/audit.js';
import { getWarehouse } from '../src/warehouses.js';
import { buildAuditReport, renderReportMarkdown, renderReportHtml } from '../src/report.js';
import { loadSigner } from '../src/signing.js';
import { anchorHead, localStubAnchor } from '../src/anchor.js';
import {
    seedMarkets,
    netPositionAtClose,
    surveillanceRapidCancels,
    MARKETS_LOG_PATH,
    TRADING_DATE,
} from '../src/markets.js';
import {
    seedEnron,
    revenueByBasis,
    debtWithHiddenLeverage,
    ENRON_LOG_PATH,
    FISCAL_YEAR,
} from '../src/enron.js';
import {
    seedLseg,
    fundamentalsSnapshot,
    reconcileGrossProfit,
    reconcileStandardizedVsAsReported,
    priceCloseSeries,
    LSEG_LOG_PATH,
    DEFAULT_RIC,
    DEFAULT_PERIOD,
} from '../src/lseg.js';
import { FakeLsegSession, RealLsegSession, ingestFundamentals } from '../src/lseg-ingest.js';
import { retentionReport, purgeExpired } from '../src/lseg-retention.js';
import {
    controlResult,
    CONTROL_STATUS,
    generateCompliancePacket,
    verifyPacket,
    renderPacketMarkdown,
} from '../src/evidence.js';
import { controlCatalog, getControl } from '../src/controls.js';

const [, , command, ...rest] = process.argv;

/** @param {number} cents */
const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

function printRows(rows, limit = 12) {
    if (rows.length === 0) {
        console.log('  (no rows)');
        return;
    }
    const columns = Object.keys(rows[0]);
    const widths = columns.map((column) =>
        Math.max(column.length, ...rows.slice(0, limit).map((row) => String(row[column]).length)),
    );
    console.log('  ' + columns.map((c, i) => c.padEnd(widths[i])).join('  '));
    console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
    for (const row of rows.slice(0, limit)) {
        console.log('  ' + columns.map((c, i) => String(row[c]).padEnd(widths[i])).join('  '));
    }
    if (rows.length > limit) console.log(`  … ${rows.length - limit} more row(s)`);
}

/** `--export <path>` value, or null. Accepts `.json` (packet) or `.md` (rendered). */
function exportPath(args) {
    const i = args.indexOf('--export');
    return i >= 0 ? args[i + 1] ?? null : null;
}

/** The value following a named flag, or null when the flag is absent. */
function flagValue(args, flag) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
}

/**
 * Write an evidence packet for one attested control result to `path`. A `.md`
 * path renders the human-readable packet; anything else writes the JSON packet.
 * Always self-verifies and prints the result, so the export is never trusted blind.
 */
function writePacket(path, { control, rows, entry, publicKey }) {
    const packet = generateCompliancePacket({ control, entry, rows, publicKey });
    const body = path.endsWith('.md') ? renderPacketMarkdown(packet) : `${JSON.stringify(packet, null, 2)}\n`;
    writeFileSync(path, body, 'utf8');
    const check = verifyPacket(packet);
    console.log(`\nEvidence packet → ${path}`);
    console.log(`  self-verifies : ${check.ok ? 'VERIFIED' : 'FAILED'}  (${Object.entries(check.checks)
        .map(([k, v]) => `${k}=${v === null ? 'n/a' : v}`)
        .join(', ')})`);
}

async function main() {
    switch (command) {
        case 'seed': {
            const result = seed();
            console.log(
                `Seeded warehouse: ${result.customers} customers, ` +
                    `${result.movements} MRR movements, ${result.spendRows} spend rows.`,
            );
            console.log('Data is synthetic and deterministic, the same seed always produces the same rows.');
            break;
        }

        case 'explain': {
            // Runs the guard alone. Useful for probing the boundary without
            // spending a model call, and for demonstrating what it refuses.
            const sql = rest.join(' ');
            try {
                const result = guard(sql);
                console.log('ALLOWED');
                console.log('  tables       :', result.tables.join(', '));
                console.log('  limitInjected:', result.limitInjected);
                console.log('  sql          :', result.sql.replace(/\n/g, '\n                 '));
            } catch (error) {
                if (!(error instanceof SqlRejected)) throw error;
                console.log('REJECTED');
                console.log('  reason :', error.reason);
                console.log('  message:', error.message);
                process.exitCode = 1;
            }
            break;
        }

        case 'ask': {
            const question = rest.join(' ');
            if (!question) {
                console.error('Usage: cc-auditor ask "how has MRR trended?"');
                process.exitCode = 2;
                return;
            }

            // A fresh install has no seeded demo warehouse; build it on first ask.
            if (ensureSeeded()) console.error('cc-auditor: built the demo warehouse on first run.');

            const result = await ask(question);

            if (!result.ok) {
                console.log(`REFUSED at ${result.stage}: ${result.reason}`);
                console.log(result.message);
                if (result.proposedSql) console.log('\nProposed SQL:\n' + result.proposedSql);
                process.exitCode = 1;
                return;
            }

            console.log('\n' + result.answer + '\n');
            console.log('SQL');
            console.log('  ' + result.sql.replace(/\n/g, '\n  '));
            console.log('\nRows');
            printRows(result.rows);
            console.log('\nProvenance');
            console.log('  tables          :', result.lineage.tables.join(', '));
            console.log('  rows returned   :', result.lineage.rowCount);
            console.log('  result hash     :', result.lineage.resultHash.slice(0, 32) + '…');
            console.log('  LLM scope       :', result.lineage.llmScope);
            console.log('  data modified   :', result.lineage.dataModified);
            console.log('  figures verified:', result.verifiedFigures);
            if (result.fellBack) {
                console.log('  NOTE            : narration failed verification; mechanical summary used');
            }
            console.log('  audit entry     : #' + result.auditSeq + '  ' + result.auditHash.slice(0, 16) + '…');
            console.log(
                '  signature       : ' +
                    (result.signed ? `signed (key ${result.signingKeyId})` : 'unsigned (no signing key configured)'),
            );
            break;
        }

        case 'audit': {
            // A signing key in the environment also yields the public key, so
            // the audit view verifies signatures as well as the hash chain.
            const signer = loadSigner();
            const verifier = signer ? { publicKey: signer.publicKey } : null;

            const exportIndex = rest.indexOf('--export');
            if (exportIndex !== -1) {
                const target = rest[exportIndex + 1];
                if (!target) {
                    console.error('Usage: cc-auditor audit --export <file.json>');
                    process.exitCode = 2;
                    return;
                }
                // Anchor the current head to an external record. Only a local
                // stub ships here; a TLaaS adapter satisfies the same interface.
                const receipt = await anchorHead(headHash(), localStubAnchor());
                const pkg = exportPackage(undefined, { verifier, anchorReceipt: receipt });
                writeFileSync(target, JSON.stringify(pkg, null, 2));
                console.log(
                    `Wrote audit package: ${target} (${pkg.entryCount} entries, ` +
                        `integrity ${pkg.integrity.ok ? 'OK' : 'BROKEN'}, ` +
                        `${pkg.signing.signedEntries}/${pkg.entryCount} signed` +
                        `${receipt ? `, anchored ${receipt.ref.slice(0, 16)}…` : ''})`,
                );
                return;
            }

            const integrity = verify(undefined, { verifier });
            console.log(
                `Audit chain: ${integrity.entries} entries, ${integrity.ok ? 'INTACT' : 'BROKEN'}` +
                    `${verifier ? ' (signatures checked)' : ''}`,
            );
            if (!integrity.ok) {
                console.log(`  broken at entry ${integrity.brokenAt}: ${integrity.reason}`);
                process.exitCode = 1;
            }
            for (const entry of readLog()) {
                console.log(
                    `  #${String(entry.seq).padStart(3)}  ${entry.at}  ` +
                        `${entry.rowCount} rows  [${entry.tables.join(', ')}]  ` +
                        `${entry.complianceTags.join(' · ')}`,
                );
                console.log(`        ${entry.question}`);
            }
            break;
        }

        case 'report': {
            // Render a shareable report over a whole audit log: every attested
            // figure, the ruleset and data behind it, and the chain status. Reads
            // only what the entries already record; adds no provenance. The
            // warehouse names the log (never a file path from the wire), exactly
            // as `audit` and `verify_audit` do.
            const warehouseFlag = flagValue(rest, '--warehouse');
            const out = flagValue(rest, '--out');
            const forceSynthetic = rest.includes('--synthetic');

            const signer = loadSigner();
            const verifier = signer ? { publicKey: signer.publicKey } : null;
            const logPath = warehouseFlag ? getWarehouse(warehouseFlag).logPath : DEFAULT_LOG_PATH;

            const entries = readLog(logPath);
            const integrity = verify(logPath, { verifier });
            const report = buildAuditReport({
                entries,
                integrity,
                warehouse: warehouseFlag ?? null,
                synthetic: forceSynthetic ? true : null,
            });

            const asHtml = typeof out === 'string' && /\.html?$/i.test(out);
            const rendered = asHtml ? renderReportHtml(report) : renderReportMarkdown(report);

            if (out) {
                writeFileSync(out, rendered);
                console.log(
                    `Wrote audit report: ${out} (${report.summary.attestations} attestations, ` +
                        `chain ${report.chain.ok ? 'INTACT' : 'BROKEN'}, ` +
                        `${report.synthetic ? 'synthetic demo data' : 'imported data'}).`,
                );
            } else {
                console.log(rendered);
            }
            break;
        }

        case 'markets': {
            const sub = rest[0];
            const signer = loadSigner();
            switch (sub) {
                case 'seed': {
                    const result = seedMarkets();
                    console.log(
                        `Seeded markets warehouse: ${result.accounts} accounts, ` +
                            `${result.orders} orders, ${result.executions} executions (session ${TRADING_DATE}).`,
                    );
                    console.log('Synthetic and deterministic; two accounts exhibit a rapid place-and-cancel pattern.');
                    break;
                }
                case 'net-position': {
                    const ticker = rest[1];
                    if (!ticker) {
                        console.error('Usage: cc-auditor markets net-position <TICKER>');
                        process.exitCode = 2;
                        return;
                    }
                    const { rows, lineage, entry } = netPositionAtClose({ ticker: ticker.toUpperCase(), signer });
                    console.log(`\nNet position in ${ticker.toUpperCase()} as of market close (${TRADING_DATE})\n`);
                    printRows(rows);
                    console.log('\nProvenance');
                    console.log('  as-of           :', new Date(lineage.asOf.value).toISOString());
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  signature       :', entry.signature ? `signed (key ${entry.signingKeyId})` : 'unsigned');
                    break;
                }
                case 'surveillance': {
                    const { rows, entry } = surveillanceRapidCancels({ signer });
                    console.log('\nMarket-abuse surveillance, rapid place-and-cancel (spoofing/layering)\n');
                    if (rows.length === 0) {
                        console.log('  No accounts breached the threshold.');
                    } else {
                        printRows(rows);
                        console.log('\n  ALERT: ' + rows.length + ' account(s) flagged for review.');
                    }
                    console.log('\nProvenance');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  compliance tags :', entry.complianceTags.join(' · '));
                    break;
                }
                case 'audit': {
                    const verifier = signer ? { publicKey: signer.publicKey } : null;
                    const integrity = verify(MARKETS_LOG_PATH, { verifier });
                    console.log(
                        `Markets audit chain: ${integrity.entries} entries, ${integrity.ok ? 'INTACT' : 'BROKEN'}` +
                            `${verifier ? ' (signatures checked)' : ''}`,
                    );
                    if (!integrity.ok) {
                        console.log(`  broken at entry ${integrity.brokenAt}: ${integrity.reason}`);
                        process.exitCode = 1;
                    }
                    for (const item of readLog(MARKETS_LOG_PATH)) {
                        console.log(`  #${String(item.seq).padStart(3)}  ${item.scenario ?? 'query'}  ${item.question}`);
                    }
                    break;
                }
                default:
                    console.log('Usage:');
                    console.log('  cc-auditor markets seed                    build the markets warehouse');
                    console.log('  cc-auditor markets net-position <TICKER>   net position at close, attested');
                    console.log('  cc-auditor markets surveillance            flag rapid place-and-cancel accounts');
                    console.log('  cc-auditor markets audit                   verify the markets audit chain');
                    process.exitCode = sub ? 2 : 0;
            }
            break;
        }

        case 'enron': {
            const sub = rest[0];
            const signer = loadSigner();
            switch (sub) {
                case 'seed': {
                    const result = seedEnron();
                    console.log(
                        `Seeded Enron POC warehouse: ${result.entities} entities, ` +
                            `${result.revenueTransactions} revenue deals, ${result.debtInstruments} debt instruments, ` +
                            `${result.reportedLineItems} reported line items.`,
                    );
                    console.log('Aggregates reconcile to Enron\'s real FY2000 10-K; transaction rows are synthetic.');
                    break;
                }
                case 'revenue': {
                    const { rows, lineage, entry } = revenueByBasis({ signer });
                    const r = rows[0] ?? {};
                    console.log(`\nFY${FISCAL_YEAR} revenue, as reported (gross) versus merchant margin (net)\n`);
                    printRows(rows);
                    console.log(
                        `\n  Reported gross revenue : $${Number(r.revenue_gross_usd_millions).toLocaleString('en-US')}m` +
                            `   (10-K total revenues)`,
                    );
                    console.log(
                        `  Net merchant margin    : $${Number(r.revenue_net_usd_millions).toLocaleString('en-US')}m`,
                    );
                    console.log('\nProvenance');
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  signature       :', entry.signature ? `signed (key ${entry.signingKeyId})` : 'unsigned');
                    const revPacket = exportPath(rest);
                    if (revPacket) {
                        writePacket(revPacket, {
                            rows,
                            entry,
                            publicKey: signer?.publicKey ?? null,
                            control: controlResult({
                                controlId: 'PI1.1',
                                criterion: 'Processing Integrity, revenue recognised on the correct basis',
                                description: `FY${FISCAL_YEAR} revenue as reported (gross) versus merchant margin (net).`,
                                status: CONTROL_STATUS.PASS,
                                figures: [
                                    { label: 'Reported gross revenue', value: r.revenue_gross_usd_millions, unit: 'usd_millions' },
                                    { label: 'Net merchant margin', value: r.revenue_net_usd_millions, unit: 'usd_millions' },
                                ],
                            }),
                        });
                    }
                    break;
                }
                case 'debt': {
                    const { rows, lineage, entry } = debtWithHiddenLeverage({ signer });
                    const r = rows[0] ?? {};
                    console.log(`\nFY${FISCAL_YEAR} debt, reported versus true, including off-balance-sheet SPEs\n`);
                    printRows(rows);
                    console.log(
                        `\n  Reported debt          : $${Number(r.reported_debt_usd_millions).toLocaleString('en-US')}m` +
                            `   (10-K short + long-term)`,
                    );
                    console.log(
                        `  True debt incl. SPEs   : $${Number(r.total_debt_incl_spe_usd_millions).toLocaleString('en-US')}m` +
                            `   (synthetic SPE amounts)`,
                    );
                    console.log('\nProvenance');
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  compliance tags :', entry.complianceTags.join(' · '));
                    const debtPacket = exportPath(rest);
                    if (debtPacket) {
                        writePacket(debtPacket, {
                            rows,
                            entry,
                            publicKey: signer?.publicKey ?? null,
                            control: controlResult({
                                controlId: 'PI1.2',
                                criterion: 'Processing Integrity, reported figures reconcile to underlying records',
                                description: `FY${FISCAL_YEAR} reported debt versus true debt including off-balance-sheet SPEs.`,
                                status: CONTROL_STATUS.PASS,
                                figures: [
                                    { label: 'Reported debt', value: r.reported_debt_usd_millions, unit: 'usd_millions' },
                                    { label: 'True debt incl. SPEs', value: r.total_debt_incl_spe_usd_millions, unit: 'usd_millions' },
                                ],
                            }),
                        });
                    }
                    break;
                }
                case 'audit': {
                    const verifier = signer ? { publicKey: signer.publicKey } : null;
                    const integrity = verify(ENRON_LOG_PATH, { verifier });
                    console.log(
                        `Enron audit chain: ${integrity.entries} entries, ${integrity.ok ? 'INTACT' : 'BROKEN'}` +
                            `${verifier ? ' (signatures checked)' : ''}`,
                    );
                    if (!integrity.ok) {
                        console.log(`  broken at entry ${integrity.brokenAt}: ${integrity.reason}`);
                        process.exitCode = 1;
                    }
                    for (const item of readLog(ENRON_LOG_PATH)) {
                        console.log(`  #${String(item.seq).padStart(3)}  ${item.scenario ?? 'query'}  ${item.question}`);
                    }
                    break;
                }
                default:
                    console.log('Usage:');
                    console.log('  cc-auditor enron seed          build the synthetic Enron POC warehouse');
                    console.log('  cc-auditor enron revenue       reported (gross) vs merchant (net) revenue, attested');
                    console.log('  cc-auditor enron debt          reported vs true debt incl. off-balance-sheet SPEs');
                    console.log('  cc-auditor enron audit         verify the Enron audit chain');
                    console.log('    add --export <file.json|.md>   write a verifiable evidence packet');
                    process.exitCode = sub ? 2 : 0;
            }
            break;
        }

        case 'lseg': {
            const sub = rest[0];
            const signer = loadSigner();
            const usdW = (v) => `$${Number(v).toLocaleString('en-US')}`;
            // A positional after the subcommand is the RIC; a second is the period.
            // Skip flags and the value each value-taking flag consumes, so e.g.
            // `--as-of 2022-06-01` does not leak its date into the RIC/period slots.
            const VALUE_FLAGS = new Set(['--as-of', '--export', '--period', '--app-key', '--from', '--to']);
            const positional = [];
            for (let i = 1; i < rest.length; i++) {
                const a = rest[i];
                if (a.startsWith('--')) {
                    if (VALUE_FLAGS.has(a)) i += 1;
                    continue;
                }
                positional.push(a);
            }
            const ric = positional[0] || DEFAULT_RIC;
            const period = positional[1] || DEFAULT_PERIOD;
            // As-of (knowledge-time) cutoff for the read scenarios; omitted means
            // the latest vintage known (the AS_OF_LATEST sentinel in lseg.js).
            const asOfIdx = rest.indexOf('--as-of');
            const asOf = asOfIdx >= 0 ? rest[asOfIdx + 1] : undefined;
            switch (sub) {
                case 'seed': {
                    const result = seedLseg();
                    console.log(
                        `Seeded LSEG warehouse: ${result.organizations} organizations (Org PermID), ` +
                            `${result.instruments} instruments (RIC aliases), ${result.fields} TR.* fields, ` +
                            `${result.datapoints} datapoints.`,
                    );
                    console.log('RICs and field codes are real LSEG identifiers; values are synthetic (validate codes via lseg-mcp).');
                    break;
                }
                case 'fundamentals': {
                    const { rows, lineage, entry } = fundamentalsSnapshot({ ric, period, asOf, signer });
                    const r = rows[0] ?? {};
                    console.log(`\n${ric} ${period}, fundamentals snapshot (LSEG TR.* fields)${asOf ? `, as of ${asOf}` : ''}\n`);
                    console.log(`  Revenue            : ${usdW(r.revenue_usd)}   (TR.Revenue)`);
                    console.log(`  Cost of revenue    : ${usdW(r.cost_of_revenue_usd)}   (TR.CostOfRevenueTotal)`);
                    console.log(`  Gross profit       : ${usdW(r.gross_profit_usd)}   (TR.GrossProfit)`);
                    console.log(`  Operating income   : ${usdW(r.operating_income_usd)}   (TR.OperatingIncome)`);
                    console.log(`  Net income         : ${usdW(r.net_income_usd)}   (TR.NetIncomeAfterTaxes)`);
                    console.log(`  Total debt         : ${usdW(r.total_debt_usd)}   (TR.TotalDebtOutstanding)`);
                    console.log('\nProvenance');
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  signature       :', entry.signature ? `signed (key ${entry.signingKeyId})` : 'unsigned');
                    break;
                }
                case 'reconcile': {
                    const { rows, lineage, entry } = reconcileGrossProfit({ ric, period, asOf, signer });
                    const r = rows[0] ?? {};
                    // Coverage first: an absent component (presence 0, or a NULL
                    // field-keyed sum) is not computable, report N/A, never a
                    // false PASS on a 0 that only means "we have no data".
                    const absent = [
                        ['Revenue', r.revenue_present],
                        ['Cost of Revenue', r.cost_present],
                        ['reported Gross Profit', r.gross_present],
                    ].filter(([, count]) => !Number(count)).map(([label]) => label);
                    // FX / basis gate: components must share currency, scale and
                    // periodicity or the subtraction is meaningless.
                    const mixed = [
                        ['currency', r.currency_variants],
                        ['scale', r.scale_variants],
                        ['periodicity', r.periodicity_variants],
                    ].filter(([, n]) => Number(n) > 1).map(([label]) => label);
                    const identity = Number(r.identity_gross_usd);
                    const reported = Number(r.reported_gross_usd);
                    const variance = identity - reported;
                    const isNA = absent.length > 0 || r.identity_gross_usd == null || r.reported_gross_usd == null;
                    const isMixed = !isNA && mixed.length > 0;
                    const status = isNA
                        ? CONTROL_STATUS.NA
                        : isMixed || variance !== 0
                            ? CONTROL_STATUS.EXCEPTION
                            : CONTROL_STATUS.PASS;
                    console.log(`\n${ric} ${period}, gross profit reconciliation${asOf ? `, as of ${asOf}` : ''}\n`);
                    if (isNA) {
                        const detail = absent.length > 0 ? `absent: ${absent.join(', ')}` : 'a required figure is absent';
                        console.log(`  Coverage                  : ⚠ N/A   (${detail})`);
                    } else if (isMixed) {
                        console.log(`  Basis                     : ✗ EXCEPTION   cannot reconcile across mixed ${mixed.join(', ')} (normalise first)`);
                    } else {
                        console.log(`  Revenue − Cost of Revenue : ${usdW(identity)}   (${r.currency})`);
                        console.log(`  Reported gross (TR.GrossProfit) : ${usdW(reported)}`);
                        console.log(`  Variance                  : ${usdW(variance)}   ${variance === 0 ? '✓ PASS' : '✗ EXCEPTION'}`);
                    }
                    console.log('\nProvenance');
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  compliance tags :', entry.complianceTags.join(' · '));
                    const packet = exportPath(rest);
                    if (packet) {
                        let figures;
                        let exception = null;
                        if (isNA) {
                            figures = [
                                { label: 'Gross profit (Revenue − Cost of Revenue)', value: r.identity_gross_usd ?? null, unit: 'usd' },
                                { label: 'Gross profit (reported, TR.GrossProfit)', value: r.reported_gross_usd ?? null, unit: 'usd' },
                                { label: 'Coverage', value: `N/A, ${absent.length > 0 ? `absent: ${absent.join(', ')}` : 'a required figure is absent'}` },
                            ];
                        } else if (isMixed) {
                            exception = `cannot reconcile across mixed ${mixed.join(', ')}, normalise to one currency/scale/periodicity first`;
                            figures = [
                                { label: 'Gross profit (Revenue − Cost of Revenue)', value: identity, unit: 'usd' },
                                { label: 'Gross profit (reported, TR.GrossProfit)', value: reported, unit: 'usd' },
                                { label: 'Basis', value: `mixed ${mixed.join(', ')}` },
                            ];
                        } else {
                            if (variance !== 0) exception = `computed gross (${usdW(identity)}) does not tie to reported (${usdW(reported)}); variance ${usdW(variance)}`;
                            figures = [
                                { label: 'Gross profit (Revenue − Cost of Revenue)', value: identity, unit: 'usd' },
                                { label: 'Gross profit (reported, TR.GrossProfit)', value: reported, unit: 'usd' },
                                { label: 'Variance', value: variance, unit: 'usd' },
                            ];
                        }
                        writePacket(packet, {
                            rows,
                            entry,
                            publicKey: signer?.publicKey ?? null,
                            control: controlResult({
                                controlId: 'PI1.1',
                                criterion: 'Processing Integrity, vendor figures reconcile to their component line items',
                                description: `${ric} ${period} gross profit: Revenue − Cost of Revenue vs reported TR.GrossProfit.`,
                                status,
                                exception,
                                figures,
                            }),
                        });
                    }
                    break;
                }
                case 'basis': {
                    const { rows, lineage, entry } = reconcileStandardizedVsAsReported({ ric, period, asOf, signer });
                    const r = rows[0] ?? {};
                    // Coverage first, same discipline as reconcile: an absent
                    // basis is N/A, never a false tie to zero.
                    const absent = [
                        ['standardized', r.standardized_present],
                        ['as-reported', r.as_reported_present],
                    ].filter(([, count]) => !Number(count)).map(([label]) => label);
                    const mixed = [
                        ['currency', r.currency_variants],
                        ['scale', r.scale_variants],
                        ['periodicity', r.periodicity_variants],
                    ].filter(([, n]) => Number(n) > 1).map(([label]) => label);
                    const standardized = Number(r.standardized_gross_usd);
                    const asReported = Number(r.as_reported_gross_usd);
                    const variance = standardized - asReported;
                    const isNA = absent.length > 0 || r.standardized_gross_usd == null || r.as_reported_gross_usd == null;
                    const isMixed = !isNA && mixed.length > 0;
                    const status = isNA
                        ? CONTROL_STATUS.NA
                        : isMixed || variance !== 0
                            ? CONTROL_STATUS.EXCEPTION
                            : CONTROL_STATUS.PASS;
                    console.log(`\n${ric} ${period}, gross profit: standardized (COA) vs as-reported${asOf ? `, as of ${asOf}` : ''}\n`);
                    if (isNA) {
                        console.log(`  Coverage                  : ⚠ N/A   (absent: ${absent.join(', ')})`);
                    } else if (isMixed) {
                        console.log(`  Basis                     : ✗ EXCEPTION   cannot compare across mixed ${mixed.join(', ')} (normalise first)`);
                    } else {
                        console.log(`  Standardized (COA)        : ${usdW(standardized)}   (${r.currency})`);
                        console.log(`  As reported (filing)      : ${usdW(asReported)}`);
                        const verdict = variance === 0
                            ? '✓ PASS (LSEG agrees with the filing)'
                            : '✗ EXCEPTION (classification difference to investigate)';
                        console.log(`  Variance                  : ${usdW(variance)}   ${verdict}`);
                    }
                    console.log('\nProvenance');
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    console.log('  compliance tags :', entry.complianceTags.join(' · '));
                    break;
                }
                case 'prices': {
                    // Pricing at its own grain (finding #6): a time series from the
                    // `prices` table, keyed by the quote PermID, not a fundamental.
                    const fromIdx = rest.indexOf('--from');
                    const toIdx = rest.indexOf('--to');
                    const from = fromIdx >= 0 ? rest[fromIdx + 1] : null;
                    const to = toIdx >= 0 ? rest[toIdx + 1] : null;
                    const { rows, lineage, entry } = priceCloseSeries({ ric, from, to, signer });
                    const span = from || to ? `  ${from ?? '…'}..${to ?? '…'}` : '';
                    console.log(`\n${ric}, closing-price series (LSEG TR.PriceClose, get_history grain)${span}\n`);
                    if (rows.length === 0) {
                        console.log('  (no prices for this instrument/range)');
                    } else {
                        for (const r of rows) {
                            console.log(`  ${r.price_date}  ${(Number(r.close) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${r.currency}`);
                        }
                    }
                    console.log('\nProvenance');
                    console.log('  result hash     :', lineage.resultHash.slice(0, 32) + '…');
                    console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                    break;
                }
                case 'ingest': {
                    const live = rest.includes('--live');
                    const periodIdx = rest.indexOf('--period');
                    const ingestPeriod = periodIdx >= 0 ? rest[periodIdx + 1] : 'FY2024';
                    // RICs are positionals that are neither a flag nor the value after --period.
                    const universe = [];
                    for (let i = 1; i < rest.length; i++) {
                        if (rest[i].startsWith('--')) continue;
                        if (rest[i - 1] === '--period') continue;
                        universe.push(rest[i]);
                    }
                    if (universe.length === 0) universe.push('IBM.N');
                    // Fundamentals only, TR.PriceClose is a Pricing time series
                    // (finding #6) and ingests via the history path, not here.
                    const fields = [
                        'TR.Revenue', 'TR.CostOfRevenueTotal', 'TR.GrossProfit', 'TR.OperatingIncome',
                        'TR.NetIncomeAfterTaxes', 'TR.TotalDebtOutstanding', 'TR.TotalAssetsReported',
                        'TR.CompanyMarketCap',
                    ];
                    const appKeyIdx = rest.indexOf('--app-key');
                    const appKey = appKeyIdx >= 0 ? rest[appKeyIdx + 1] : undefined;
                    const session = live ? new RealLsegSession(appKey ? { appKey } : {}) : new FakeLsegSession();
                    console.log(
                        `Ingesting ${universe.join(', ')} ${ingestPeriod} via ${live ? 'RealLsegSession (live LSEG Workspace)' : 'FakeLsegSession (synthetic, no entitlement)'}…`,
                    );
                    try {
                        const result = ingestFundamentals({ session, universe, fields, period: ingestPeriod });
                        console.log(
                            `Landed ${result.datapoints} datapoints across ${result.instruments} instrument(s). ` +
                                `Run: cc-auditor lseg reconcile ${universe[0]} ${ingestPeriod}`,
                        );
                    } catch (error) {
                        console.error('Ingest halted:', error.message);
                        process.exitCode = 1;
                    }
                    break;
                }
                case 'retention': {
                    // Cache retention + licensing-tag governance (finding #7).
                    const report = retentionReport({ asOf });
                    console.log(`\nLSEG cache retention & licensing tags${asOf ? `, as of ${asOf}` : ''}\n`);
                    for (const s of report.sources) {
                        const ttl = s.ttlSet ? `${s.retentionDays}d` : ', ';
                        console.log(`  ${(s.usageClass ?? 'UNTAGGED').padEnd(12)} TTL ${ttl.padStart(5)}  rows ${String(s.rows).padStart(3)}  stale ${String(s.stale).padStart(3)}  oldest ${s.oldest ?? ', '}`);
                        console.log(`      ${s.source}`);
                    }
                    if (report.ok) {
                        console.log('\n  ✓ PASS, every source tagged, TTL set, nothing held past it');
                    } else {
                        const gaps = [
                            report.untagged.length ? `${report.untagged.length} untagged` : null,
                            report.missingTtl.length ? `${report.missingTtl.length} no-TTL` : null,
                            report.staleTotal ? `${report.staleTotal} past TTL` : null,
                        ].filter(Boolean).join(', ');
                        console.log(`\n  ✗ EXCEPTION, data-governance gap(s): ${gaps}`);
                    }
                    if (rest.includes('--purge')) {
                        const purge = purgeExpired({ asOf });
                        console.log(`\n  Purged ${purge.total} row(s) past TTL (fundamentals ${purge.purged.fundamentals}, prices ${purge.purged.prices}).`);
                    } else if (report.staleTotal > 0) {
                        console.log('  Run with --purge to delete rows held past their TTL.');
                    }
                    break;
                }
                case 'license': {
                    // The licensing/redistribution posture, read from the data_sources tags.
                    const report = retentionReport({});
                    console.log('\nLSEG licensing / redistribution, sign off before a live key\n');
                    for (const s of report.sources) {
                        console.log(`  - ${s.source}`);
                        console.log(`      usage: ${s.usageClass ?? 'UNTAGGED'}   cache TTL: ${s.ttlSet ? s.retentionDays + ' days' : 'NOT SET'}   redistribution: ${s.redistribution ?? ', '}`);
                    }
                    console.log('\n  Full sign-off checklist: auditor-core/db/lseg-licensing.md');
                    console.log('  These tags encode a policy; they do not grant a right, confirm terms against the LSEG agreement.');
                    break;
                }
                case 'audit': {
                    const verifier = signer ? { publicKey: signer.publicKey } : null;
                    const integrity = verify(LSEG_LOG_PATH, { verifier });
                    console.log(
                        `LSEG audit chain: ${integrity.entries} entries, ${integrity.ok ? 'INTACT' : 'BROKEN'}` +
                            `${verifier ? ' (signatures checked)' : ''}`,
                    );
                    if (!integrity.ok) {
                        console.log(`  broken at entry ${integrity.brokenAt}: ${integrity.reason}`);
                        process.exitCode = 1;
                    }
                    for (const item of readLog(LSEG_LOG_PATH)) {
                        console.log(`  #${String(item.seq).padStart(3)}  ${item.scenario ?? 'query'}  ${item.question}`);
                    }
                    break;
                }
                default:
                    console.log('Usage:');
                    console.log('  cc-auditor lseg seed                     build the LSEG fundamentals warehouse');
                    console.log('  cc-auditor lseg fundamentals [RIC] [FY]  attested fundamentals snapshot (default IBM.N FY2023)');
                    console.log('  cc-auditor lseg reconcile [RIC] [FY]     gross profit = Revenue − Cost of Revenue, attested (standardized integrity)');
                    console.log('  cc-auditor lseg basis [RIC] [FY]         standardized (COA) gross profit vs as-reported, attested');
                    console.log('    add --as-of YYYY-MM-DD to fundamentals/reconcile/basis   read the vintage known at that knowledge date');
                    console.log('  cc-auditor lseg prices [RIC] [--from DATE] [--to DATE]   closing-price time series (own grain, quote PermID)');
                    console.log('  cc-auditor lseg ingest [RIC...] [--period FY2024] [--live] [--app-key KEY]   land data via the ingest seam');
                    console.log('    --live needs an LSEG entitlement: set LSEG_APP_KEY (or pass --app-key) + install lseg-data');
                    console.log('  cc-auditor lseg retention [--as-of DATE] [--purge]   cache-TTL + licensing-tag governance (finding #7)');
                    console.log('  cc-auditor lseg license                  show the per-source licensing/redistribution posture');
                    console.log('  cc-auditor lseg audit                    verify the LSEG audit chain');
                    console.log('    add --export <file.json|.md> to reconcile   write a verifiable evidence packet');
                    process.exitCode = sub ? 2 : 0;
            }
            break;
        }

        case 'controls': {
            const sub = rest[0];
            const signer = loadSigner();
            switch (sub) {
                case 'list': {
                    console.log('\nSOC 2 control catalog\n');
                    for (const c of controlCatalog()) {
                        console.log(`  ${c.id}`);
                        console.log(`    ${c.criterion}`);
                        console.log(`    warehouse: ${c.warehouse}, ${c.description}\n`);
                    }
                    break;
                }
                case 'run': {
                    const id = rest[1];
                    if (!id) {
                        console.error('Usage: cc-auditor controls run <control-id> [--export <file>]');
                        process.exitCode = 2;
                        return;
                    }
                    let control;
                    let entry;
                    let rows;
                    try {
                        ({ control, entry, rows } = getControl(id).run({ signer }));
                    } catch (error) {
                        console.error(error.message);
                        process.exitCode = 2;
                        return;
                    }
                    console.log(`\n${control.controlId}, ${control.criterion}`);
                    console.log(`  status: ${control.status}${control.exception ? `  (${control.exception})` : ''}\n`);
                    for (const f of control.figures) {
                        console.log(`  ${f.label.padEnd(32)} ${f.value}${f.unit ? ' ' + f.unit : ''}`);
                    }
                    if (entry) {
                        console.log('\nProvenance');
                        console.log('  result hash     :', entry.resultHash.slice(0, 32) + '…');
                        console.log('  audit entry     : #' + entry.seq + '  ' + entry.hash.slice(0, 16) + '…');
                        console.log('  signature       :', entry.signature ? `signed (key ${entry.signingKeyId})` : 'unsigned');
                    }
                    const out = exportPath(rest);
                    if (out && entry) {
                        writePacket(out, { control, rows, entry, publicKey: signer?.publicKey ?? null });
                    } else if (out) {
                        console.log('\n  (this control verifies an existing chain; the chain itself is the evidence, no query packet)');
                    }
                    if (control.status !== CONTROL_STATUS.PASS) process.exitCode = 1;
                    break;
                }
                default:
                    console.log('Usage:');
                    console.log('  cc-auditor controls list             list the SOC 2 control catalog');
                    console.log('  cc-auditor controls run <id>         run a control, print PASS/EXCEPTION');
                    console.log('    add --export <file.json|.md>   also write a verifiable evidence packet');
                    process.exitCode = sub ? 2 : 0;
            }
            break;
        }

        case 'serve': {
            // The HTTP API must never run unauthenticated: it is a server-to-server
            // surface over the same tools as the MCP server, so an open port is an
            // open door to every warehouse. Require a bearer token at startup rather
            // than defaulting to "dev, no auth".
            if (!process.env.ENGINE_SERVICE_TOKEN) {
                console.error(
                    'cc-auditor serve: ENGINE_SERVICE_TOKEN is not set. The HTTP API will not start ' +
                        'unauthenticated. Set a strong bearer token first, e.g.\n' +
                        '  export ENGINE_SERVICE_TOKEN="$(openssl rand -hex 32)"',
                );
                process.exitCode = 1;
                return;
            }
            const portArg = rest[rest.indexOf('--port') + 1];
            const port = Number(portArg ?? process.env.PORT ?? 8787);
            const { startApiServer } = await import('../src/http-server.js');
            await startApiServer({ port });
            console.error(
                `cc-auditor HTTP API on :${port}, bearer-token required. ` +
                    `Routes: GET /health, GET /tools, POST /tools/<name>, GET /resources.`,
            );
            break;
        }

        case 'doctor': {
            // Check the install and print the MCP client config. Local only.
            const { runDoctor, formatDoctor } = await import('../src/doctor.js');
            const report = await runDoctor({ rebuild: rest.includes('--rebuild') });
            console.log(formatDoctor(report));
            if (report.failures > 0) process.exitCode = 1;
            break;
        }

        case 'import': {
            // Import a buyer's expenditure CSV (local only). Without --map it
            // proposes a column mapping and writes nothing; with --map it builds
            // the ledger, records the source hash, and runs the three queries.
            const { runImport, formatImport } = await import('../src/import.js');
            const { ImportPathError } = await import('../src/paths.js');
            const { ImportError } = await import('../src/import-csv.js');
            // --pack selects the warehouse the CSV is imported into (default
            // municipal). Each pack has its own canonical schema and its own
            // optional companion files; iolta, construction, nonprofit and
            // insurance route to their own runners.
            const { IMPORT_PACKS } = await import('../src/import-spec.js');
            const packIdx = rest.indexOf('--pack');
            const pack = packIdx !== -1 ? rest[packIdx + 1] : 'municipal';
            if (!IMPORT_PACKS.includes(pack)) {
                console.error(`cc-auditor import: unknown --pack "${pack}" (known: ${IMPORT_PACKS.join(', ')}).`);
                process.exitCode = 2;
                return;
            }
            // Read a mapping JSON, accepting a bare object or the saved {mapping:{…}} form.
            const readMapping = (flag) => {
                const i = rest.indexOf(flag);
                if (i === -1) return undefined;
                const mapFile = rest[i + 1];
                if (!mapFile) {
                    console.error(`${flag} needs a path to a mapping JSON file (field -> column).`);
                    process.exitCode = 2;
                    return null;
                }
                try {
                    const doc = JSON.parse(readFileSync(mapFile, 'utf8'));
                    return doc && typeof doc.mapping === 'object' ? doc.mapping : doc;
                } catch (error) {
                    console.error(`Could not read mapping ${mapFile}: ${error.message}`);
                    process.exitCode = 2;
                    return null;
                }
            };

            if (pack === 'iolta') {
                const { runIoltaImport, formatIoltaImport } = await import('../src/import-iolta-run.js');
                const bankIdx = rest.indexOf('--bank');
                const bankFile = bankIdx !== -1 ? rest[bankIdx + 1] : null;
                const invoicesIdx = rest.indexOf('--invoices');
                const invoicesFile = invoicesIdx !== -1 ? rest[invoicesIdx + 1] : null;
                const ioltaFlagValues = new Set(
                    ['--pack', '--map', '--bank', '--bank-map', '--invoices', '--invoices-map']
                        .map((f) => rest.indexOf(f))
                        .filter((i) => i !== -1)
                        .map((i) => rest[i + 1])
                        .filter(Boolean),
                );
                const journalFile = rest.find((a) => !a.startsWith('--') && !ioltaFlagValues.has(a));
                if (!journalFile) {
                    console.error('Usage: cc-auditor import --pack iolta <journal.csv> [--map mapping.json] [--bank bank.csv --bank-map bank.json] [--invoices inv.csv --invoices-map inv.json]');
                    console.error('  Set CIVIC_IMPORT_DIR to the folder your CSV lives in. Without --map, prints a proposed mapping.');
                    console.error('  --bank adds bank reconciliation snapshots so three-way-reconciliation can tie.');
                    console.error('  --invoices adds fee invoices so unsupported-fee-transfers can check each transfer.');
                    process.exitCode = 2;
                    return;
                }
                const mapping = readMapping('--map') ?? null;
                if (process.exitCode === 2) return;
                const bankMapping = readMapping('--bank-map');
                if (process.exitCode === 2) return;
                const bankSnapshots = bankFile ? { file: bankFile, mapping: bankMapping ?? null } : null;
                const invoicesMapping = readMapping('--invoices-map');
                if (process.exitCode === 2) return;
                const feeInvoices = invoicesFile ? { file: invoicesFile, mapping: invoicesMapping ?? null } : null;
                try {
                    const result = await runIoltaImport({ file: journalFile, mapping, bankSnapshots, feeInvoices, signer: loadSigner() });
                    console.log(formatIoltaImport(result));
                    if (result.stage === 'imported' && result.gate && !result.gate.ok) process.exitCode = 1;
                } catch (error) {
                    if (error instanceof ImportPathError || error instanceof ImportError) {
                        console.error(`cc-auditor import: ${error.message}`);
                        process.exitCode = 1;
                        return;
                    }
                    throw error;
                }
                break;
            }

            if (pack === 'construction') {
                // The jobs / WIP schedule is the primary file; the five companion
                // files (GL revenue, balance-sheet balances, prior WIP snapshots,
                // retainage, subcontractor payments) are driven generically from
                // the spec: each companion's file flag is its map flag minus
                // "-map" (--gl-map → --gl, etc.).
                const { CONSTRUCTION_SPEC } = await import('../src/import-spec.js');
                const { runConstructionImport, formatConstructionImport } = await import('../src/import-construction-run.js');
                const companionFlags = CONSTRUCTION_SPEC.companions.map((c) => ({
                    key: c.resultKey,
                    fileFlag: c.mapFlag.replace(/-map$/, ''),
                    mapFlag: c.mapFlag,
                }));
                const valueFlags = ['--pack', '--map', ...companionFlags.flatMap((c) => [c.fileFlag, c.mapFlag])];
                const flagValues = new Set(
                    valueFlags.map((f) => rest.indexOf(f)).filter((i) => i !== -1).map((i) => rest[i + 1]).filter(Boolean),
                );
                const file = rest.find((a) => !a.startsWith('--') && !flagValues.has(a));
                if (!file) {
                    console.error('Usage: cc-auditor import --pack construction <jobs.csv> [--map mapping.json] \\');
                    console.error('         [--gl gl.csv --gl-map gl.json] [--balances bal.csv --balances-map bal.json] \\');
                    console.error('         [--snapshots snap.csv --snapshots-map snap.json] [--retainage ret.csv --retainage-map ret.json] \\');
                    console.error('         [--subpayments sub.csv --subpayments-map sub.json]');
                    console.error('  Set CIVIC_IMPORT_DIR to the folder your CSV lives in. Without --map, prints a proposed mapping.');
                    console.error('  The jobs file is the WIP schedule; each companion fills one more table so a control can tie:');
                    console.error('  --gl (earned revenue ties the GL), --balances (over/underbillings tie the balance sheet),');
                    console.error('  --snapshots (margin fade), --retainage (retainage reconciles), --subpayments (lien waivers).');
                    process.exitCode = 2;
                    return;
                }
                const mapping = readMapping('--map') ?? null;
                if (process.exitCode === 2) return;
                const companionArgs = {};
                for (const c of companionFlags) {
                    const fi = rest.indexOf(c.fileFlag);
                    const companionFile = fi !== -1 ? rest[fi + 1] : null;
                    const companionMap = readMapping(c.mapFlag);
                    if (process.exitCode === 2) return;
                    companionArgs[c.key] = companionFile ? { file: companionFile, mapping: companionMap ?? null } : null;
                }
                try {
                    const result = await runConstructionImport({ file, mapping, ...companionArgs, signer: loadSigner() });
                    console.log(formatConstructionImport(result));
                    if (result.stage === 'imported' && result.gate && !result.gate.ok) process.exitCode = 1;
                } catch (error) {
                    if (error instanceof ImportPathError || error instanceof ImportError) {
                        console.error(`cc-auditor import: ${error.message}`);
                        process.exitCode = 1;
                        return;
                    }
                    throw error;
                }
                break;
            }

            if (pack === 'nonprofit') {
                // The fund register is the primary file; the five companion files
                // (expenses, restriction releases, account balances, net assets,
                // federal awards) are driven generically from the spec: each
                // companion's file flag is its map flag minus "-map" (--expenses-map
                // → --expenses, etc.).
                const { NONPROFIT_SPEC } = await import('../src/import-spec.js');
                const { runNonprofitImport, formatNonprofitImport } = await import('../src/import-nonprofit-run.js');
                const companionFlags = NONPROFIT_SPEC.companions.map((c) => ({
                    key: c.resultKey,
                    fileFlag: c.mapFlag.replace(/-map$/, ''),
                    mapFlag: c.mapFlag,
                }));
                const valueFlags = ['--pack', '--map', ...companionFlags.flatMap((c) => [c.fileFlag, c.mapFlag])];
                const flagValues = new Set(
                    valueFlags.map((f) => rest.indexOf(f)).filter((i) => i !== -1).map((i) => rest[i + 1]).filter(Boolean),
                );
                const file = rest.find((a) => !a.startsWith('--') && !flagValues.has(a));
                if (!file) {
                    console.error('Usage: cc-auditor import --pack nonprofit <funds.csv> [--map mapping.json] \\');
                    console.error('         [--expenses exp.csv --expenses-map exp.json] [--releases rel.csv --releases-map rel.json] \\');
                    console.error('         [--balances bal.csv --balances-map bal.json] [--net-assets na.csv --net-assets-map na.json] \\');
                    console.error('         [--federal-awards fa.csv --federal-awards-map fa.json]');
                    console.error('  Set CIVIC_IMPORT_DIR to the folder your CSV lives in. Without --map, prints a proposed mapping.');
                    console.error('  The funds file is the restricted-fund register; each companion fills one more table so a control can read:');
                    console.error('  --expenses (restricted spending + the functional-expense grid), --releases (releases tie spending),');
                    console.error('  --balances + --net-assets (restricted-cash coverage), --federal-awards (the Single Audit threshold).');
                    process.exitCode = 2;
                    return;
                }
                const mapping = readMapping('--map') ?? null;
                if (process.exitCode === 2) return;
                const companionArgs = {};
                for (const c of companionFlags) {
                    const fi = rest.indexOf(c.fileFlag);
                    const companionFile = fi !== -1 ? rest[fi + 1] : null;
                    const companionMap = readMapping(c.mapFlag);
                    if (process.exitCode === 2) return;
                    companionArgs[c.key] = companionFile ? { file: companionFile, mapping: companionMap ?? null } : null;
                }
                try {
                    const result = await runNonprofitImport({ file, mapping, ...companionArgs, signer: loadSigner() });
                    console.log(formatNonprofitImport(result));
                    if (result.stage === 'imported' && result.gate && !result.gate.ok) process.exitCode = 1;
                } catch (error) {
                    if (error instanceof ImportPathError || error instanceof ImportError) {
                        console.error(`cc-auditor import: ${error.message}`);
                        process.exitCode = 1;
                        return;
                    }
                    throw error;
                }
                break;
            }

            if (pack === 'insurance') {
                // The premium-trust ledger is the primary file; the four companion
                // files (policies, commission receipts, binders, trust bank
                // snapshots) are driven generically from the spec: each companion's
                // file flag is its map flag minus "-map" (--policies-map →
                // --policies, etc.). policies must precede the receipts and binders.
                const { INSURANCE_SPEC } = await import('../src/import-spec.js');
                const { runInsuranceImport, formatInsuranceImport } = await import('../src/import-insurance-run.js');
                const companionFlags = INSURANCE_SPEC.companions.map((c) => ({
                    key: c.resultKey,
                    fileFlag: c.mapFlag.replace(/-map$/, ''),
                    mapFlag: c.mapFlag,
                }));
                const valueFlags = ['--pack', '--map', ...companionFlags.flatMap((c) => [c.fileFlag, c.mapFlag])];
                const flagValues = new Set(
                    valueFlags.map((f) => rest.indexOf(f)).filter((i) => i !== -1).map((i) => rest[i + 1]).filter(Boolean),
                );
                const file = rest.find((a) => !a.startsWith('--') && !flagValues.has(a));
                if (!file) {
                    console.error('Usage: cc-auditor import --pack insurance <trust-ledger.csv> [--map mapping.json] \\');
                    console.error('         [--policies pol.csv --policies-map pol.json] [--commissions rec.csv --commissions-map rec.json] \\');
                    console.error('         [--binders bnd.csv --binders-map bnd.json] [--bank bank.csv --bank-map bank.json]');
                    console.error('  Set CIVIC_IMPORT_DIR to the folder your CSV lives in. Without --map, prints a proposed mapping.');
                    console.error('  The trust-ledger file is the premium-trust ledger; each companion fills one more table so a control can read:');
                    console.error('  --policies + --commissions (commission-variance-audit), --binders (eo-unbound-exposure),');
                    console.error('  --bank (trust-account-solvency). Import --policies before --commissions / --binders (they reference it).');
                    process.exitCode = 2;
                    return;
                }
                const mapping = readMapping('--map') ?? null;
                if (process.exitCode === 2) return;
                const companionArgs = {};
                for (const c of companionFlags) {
                    const fi = rest.indexOf(c.fileFlag);
                    const companionFile = fi !== -1 ? rest[fi + 1] : null;
                    const companionMap = readMapping(c.mapFlag);
                    if (process.exitCode === 2) return;
                    companionArgs[c.key] = companionFile ? { file: companionFile, mapping: companionMap ?? null } : null;
                }
                try {
                    const result = await runInsuranceImport({ file, mapping, ...companionArgs, signer: loadSigner() });
                    console.log(formatInsuranceImport(result));
                    if (result.stage === 'imported' && result.gate && !result.gate.ok) process.exitCode = 1;
                } catch (error) {
                    if (error instanceof ImportPathError || error instanceof ImportError) {
                        console.error(`cc-auditor import: ${error.message}`);
                        process.exitCode = 1;
                        return;
                    }
                    throw error;
                }
                break;
            }

            if (pack === 'excise') {
                // The taxable removals are the primary file; the three companion
                // files (rate schedule, operations reports, excise returns) are
                // driven generically from the spec: each companion's file flag is
                // its map flag minus "-map" (--rates-map → --rates, etc.).
                const { EXCISE_SPEC } = await import('../src/import-spec.js');
                const { runExciseImport, formatExciseImport } = await import('../src/import-excise-run.js');
                const companionFlags = EXCISE_SPEC.companions.map((c) => ({
                    key: c.resultKey,
                    fileFlag: c.mapFlag.replace(/-map$/, ''),
                    mapFlag: c.mapFlag,
                }));
                const valueFlags = ['--pack', '--map', ...companionFlags.flatMap((c) => [c.fileFlag, c.mapFlag])];
                const flagValues = new Set(
                    valueFlags.map((f) => rest.indexOf(f)).filter((i) => i !== -1).map((i) => rest[i + 1]).filter(Boolean),
                );
                const file = rest.find((a) => !a.startsWith('--') && !flagValues.has(a));
                if (!file) {
                    console.error('Usage: cc-auditor import --pack excise <removals.csv> [--map mapping.json] \\');
                    console.error('         [--rates rates.csv --rates-map rates.json] [--operations ops.csv --operations-map ops.json] \\');
                    console.error('         [--returns ret.csv --returns-map ret.json]');
                    console.error('  Set CIVIC_IMPORT_DIR to the folder your CSV lives in. Without --map, prints a proposed mapping.');
                    console.error('  The removals file is the taxable removals from bond; each companion fills one more table so a control can tie:');
                    console.error('  --rates (liability-vs-remitted reads the per-barrel rate), --operations (inventory-rollforward,');
                    console.error('  report-vs-return, loss-variance), --returns (liability-vs-remitted, report-vs-return, missing-or-late-filings).');
                    process.exitCode = 2;
                    return;
                }
                const mapping = readMapping('--map') ?? null;
                if (process.exitCode === 2) return;
                const companionArgs = {};
                for (const c of companionFlags) {
                    const fi = rest.indexOf(c.fileFlag);
                    const companionFile = fi !== -1 ? rest[fi + 1] : null;
                    const companionMap = readMapping(c.mapFlag);
                    if (process.exitCode === 2) return;
                    companionArgs[c.key] = companionFile ? { file: companionFile, mapping: companionMap ?? null } : null;
                }
                try {
                    const result = await runExciseImport({ file, mapping, ...companionArgs, signer: loadSigner() });
                    console.log(formatExciseImport(result));
                    if (result.stage === 'imported' && result.gate && !result.gate.ok) process.exitCode = 1;
                } catch (error) {
                    if (error instanceof ImportPathError || error instanceof ImportError) {
                        console.error(`cc-auditor import: ${error.message}`);
                        process.exitCode = 1;
                        return;
                    }
                    throw error;
                }
                break;
            }

            if (pack === 'schools') {
                // The activity collections are the primary file; the six companion
                // files (activity accounts, activity disbursements, federal programs,
                // federal costs, budget lines, expenditures) are driven generically
                // from the spec: each companion's file flag is its map flag minus
                // "-map" (--accounts-map → --accounts, etc.).
                const { SCHOOLS_SPEC } = await import('../src/import-spec.js');
                const { runSchoolsImport, formatSchoolsImport } = await import('../src/import-schools-run.js');
                const companionFlags = SCHOOLS_SPEC.companions.map((c) => ({
                    key: c.resultKey,
                    fileFlag: c.mapFlag.replace(/-map$/, ''),
                    mapFlag: c.mapFlag,
                }));
                const valueFlags = ['--pack', '--map', ...companionFlags.flatMap((c) => [c.fileFlag, c.mapFlag])];
                const flagValues = new Set(
                    valueFlags.map((f) => rest.indexOf(f)).filter((i) => i !== -1).map((i) => rest[i + 1]).filter(Boolean),
                );
                const file = rest.find((a) => !a.startsWith('--') && !flagValues.has(a));
                if (!file) {
                    console.error('Usage: cc-auditor import --pack schools <collections.csv> [--map mapping.json] \\');
                    console.error('         [--accounts acct.csv --accounts-map acct.json] [--disbursements dis.csv --disbursements-map dis.json] \\');
                    console.error('         [--programs prog.csv --programs-map prog.json] [--costs cost.csv --costs-map cost.json] \\');
                    console.error('         [--budget-lines bl.csv --budget-lines-map bl.json] [--expenditures exp.csv --expenditures-map exp.json]');
                    console.error('  Set CIVIC_IMPORT_DIR to the folder your CSV lives in. Without --map, prints a proposed mapping.');
                    console.error('  The collections file is the activity-fund cash receipts; each companion fills one more table so a control can read:');
                    console.error('  --accounts + --disbursements (activity-negative-balances, activity-unapproved-disbursements),');
                    console.error('  --programs + --costs (federal-outside-period), --budget-lines + --expenditures (budget-variance).');
                    console.error('  No student records are read or stored; the controls reconcile accounts, programs and budget lines by code only.');
                    process.exitCode = 2;
                    return;
                }
                const mapping = readMapping('--map') ?? null;
                if (process.exitCode === 2) return;
                const companionArgs = {};
                for (const c of companionFlags) {
                    const fi = rest.indexOf(c.fileFlag);
                    const companionFile = fi !== -1 ? rest[fi + 1] : null;
                    const companionMap = readMapping(c.mapFlag);
                    if (process.exitCode === 2) return;
                    companionArgs[c.key] = companionFile ? { file: companionFile, mapping: companionMap ?? null } : null;
                }
                try {
                    const result = await runSchoolsImport({ file, mapping, ...companionArgs, signer: loadSigner() });
                    console.log(formatSchoolsImport(result));
                    if (result.stage === 'imported' && result.gate && !result.gate.ok) process.exitCode = 1;
                } catch (error) {
                    if (error instanceof ImportPathError || error instanceof ImportError) {
                        console.error(`cc-auditor import: ${error.message}`);
                        process.exitCode = 1;
                        return;
                    }
                    throw error;
                }
                break;
            }

            // The first non-flag argument is the CSV file name within CIVIC_IMPORT_DIR.
            // The first non-flag argument is the expenditure CSV; --grants names
            // an optional grant-register CSV applied onto the same ledger.
            const grantsIdx = rest.indexOf('--grants');
            const grantsFile = grantsIdx !== -1 ? rest[grantsIdx + 1] : null;
            const drawdownsIdx = rest.indexOf('--drawdowns');
            const drawdownsFile = drawdownsIdx !== -1 ? rest[drawdownsIdx + 1] : null;
            const flagValues = new Set(
                ['--pack', '--map', '--grants', '--grants-map', '--drawdowns', '--drawdowns-map']
                    .map((f) => rest.indexOf(f))
                    .filter((i) => i !== -1)
                    .map((i) => rest[i + 1])
                    .filter(Boolean),
            );
            const file = rest.find((a) => !a.startsWith('--') && !flagValues.has(a));
            if (!file) {
                console.error('Usage: cc-auditor import <file.csv> [--pack municipal|iolta|construction|nonprofit|insurance|excise|schools] [--map mapping.json] [--grants register.csv --grants-map grants.json] [--drawdowns draws.csv --drawdowns-map draws.json]');
                console.error('  Set CIVIC_IMPORT_DIR to the folder your CSV lives in. Without --map, prints a proposed mapping.');
                console.error('  --grants adds a grant register (award amounts) so grant-status is meaningful.');
                console.error('  --drawdowns adds grant cash drawn down, so grant-status measures drawn vs spent.');
                process.exitCode = 2;
                return;
            }
            const mapping = readMapping('--map') ?? null;
            if (process.exitCode === 2) return;
            const grantsMapping = readMapping('--grants-map');
            if (process.exitCode === 2) return;
            const grantRegister = grantsFile ? { file: grantsFile, mapping: grantsMapping ?? null } : null;
            const drawdownsMapping = readMapping('--drawdowns-map');
            if (process.exitCode === 2) return;
            const grantDrawdowns = drawdownsFile ? { file: drawdownsFile, mapping: drawdownsMapping ?? null } : null;
            try {
                const result = await runImport({ file, mapping, grantRegister, grantDrawdowns, signer: loadSigner() });
                console.log(formatImport(result));
                if (result.stage === 'imported' && result.gate && !result.gate.ok) process.exitCode = 1;
            } catch (error) {
                if (error instanceof ImportPathError || error instanceof ImportError) {
                    console.error(`cc-auditor import: ${error.message}`);
                    process.exitCode = 1;
                    return;
                }
                throw error;
            }
            break;
        }

        case 'ruleset': {
            // Inspect, sign and key-manage Civic-Chain rulesets (S9). Local only.
            const sub = rest[0];
            const { loadRuleset, writeRulesetSignature } = await import('../src/ruleset.js');
            switch (sub) {
                case 'list': {
                    const { loadPacks } = await import('../src/packs.js');
                    const packs = loadPacks();
                    console.log(`\nBundled rulesets (${packs.length} packs)\n`);
                    for (const pack of packs) {
                        const r = loadRuleset(pack.rulesetPath);
                        console.log(`  ${r.name}/${r.version}  —  ${pack.label} (warehouse "${pack.warehouse}")`);
                        console.log(`    status      : ${r.signature.status}${r.signature.signedBy ? ` (key ${r.signature.signedBy})` : ''}`);
                        console.log(`    contentHash : ${r.contentHash}`);
                        console.log(`    queries     : ${Object.keys(r.queries).join(', ')}`);
                    }
                    console.log('\nStand one up from a checkout: node scripts/verify-setup.js --pack <warehouse>');
                    break;
                }
                case 'show': {
                    const file = rest[1];
                    if (!file) {
                        console.error('Usage: cc-auditor ruleset show <ruleset.json>');
                        process.exitCode = 2;
                        return;
                    }
                    const r = loadRuleset(file);
                    console.log(`${r.name}/${r.version}  ${r.signature.status}  ${r.contentHash}`);
                    if (r.signature.status === 'modified') {
                        console.log('  WARNING: this ruleset does not match a Civic-Chain signature (edited or signed by another key).');
                        process.exitCode = 1;
                    }
                    break;
                }
                case 'keygen': {
                    // Generate an offline Civic-Chain signing key. The private key
                    // must never live in the repo or CI; write it somewhere safe.
                    const outIdx = rest.indexOf('--out');
                    const out = outIdx >= 0 ? rest[outIdx + 1] : null;
                    const { generateSigner } = await import('../src/signing.js');
                    const { privateKey, publicKey, keyId } = generateSigner();
                    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
                    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
                    console.log(`Civic-Chain ruleset key, id ${keyId}`);
                    if (out) {
                        writeFileSync(out, privPem, { mode: 0o600 });
                        console.log(`  private key → ${out} (keep OFFLINE: never commit, never put in CI)`);
                    } else {
                        console.log('\n' + privPem);
                    }
                    console.log('Public key (commit as assets/civic-chain-ruleset-pub.pem):\n');
                    console.log(pubPem);
                    break;
                }
                case 'sign': {
                    const file = rest[1];
                    const keyIdx = rest.indexOf('--key');
                    const keyPath = keyIdx >= 0 ? rest[keyIdx + 1] : null;
                    if (!file || !keyPath) {
                        console.error('Usage: cc-auditor ruleset sign <ruleset.json> --key <private-key.pem>');
                        process.exitCode = 2;
                        return;
                    }
                    const { createPrivateKey, createPublicKey } = await import('node:crypto');
                    const { keyIdOf } = await import('../src/signing.js');
                    const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
                    const publicKey = createPublicKey(privateKey);
                    const sigPath = writeRulesetSignature(file, { privateKey, publicKey, keyId: keyIdOf(publicKey) });
                    console.log(`Signed ${file} → ${sigPath} (key ${keyIdOf(publicKey)}).`);
                    break;
                }
                default:
                    console.log('Usage:');
                    console.log('  cc-auditor ruleset list                        list bundled rulesets + signature status');
                    console.log('  cc-auditor ruleset show <ruleset.json>         load a ruleset, print its status + content hash');
                    console.log('  cc-auditor ruleset keygen [--out key.pem]      generate an offline Civic-Chain signing key');
                    console.log('  cc-auditor ruleset sign <ruleset.json> --key key.pem   write a detached signature');
                    process.exitCode = sub ? 2 : 0;
            }
            break;
        }

        case 'mcp': {
            // Validate a custom warehouse before the transport starts, so a bad
            // CIVIC_DB_PATH / CIVIC_ALLOWLIST_PATH fails here, on stderr,
            // rather than as an error on the client's first resource read.
            try {
                const { loadCustomWarehouse } = await import('../src/custom.js');
                const custom = loadCustomWarehouse();
                if (custom) {
                    const { guard } = await import('../src/guard.js');
                    const { validateNamedQueries } = await import('../src/named-run.js');
                    const checked = validateNamedQueries(custom, guard);
                    console.error(
                        `cc-auditor: custom warehouse "${custom.name}" loaded from ${custom.dbPath} ` +
                            `(${Object.keys(custom.queries).length} named queries, ${checked} statements guarded).`,
                    );
                } else if (ensureSeeded()) {
                    // No warehouse configured: this is the zero-config demo. Build
                    // the SaaS demo warehouse so canonical queries answer at once.
                    console.error('cc-auditor: no CIVIC_DB_PATH set; built the SaaS demo warehouse for a zero-config demo.');
                }
            } catch (error) {
                console.error(`cc-auditor: ${error.message}`);
                process.exitCode = 1;
                return;
            }
            try {
                const { startMcpServer } = await import('../src/mcp-server.js');
                await startMcpServer();
                console.error('cc-auditor MCP server running on stdio (tools + schema resources).');
                // The stdio transport keeps the process alive to serve requests.
            } catch (error) {
                if (error.code === 'ERR_MODULE_NOT_FOUND') {
                    console.error('The MCP server needs @modelcontextprotocol/sdk, run `npm install` first.');
                    process.exitCode = 1;
                    return;
                }
                throw error;
            }
            break;
        }

        default:
            console.log('Usage:');
            console.log('  cc-auditor seed                      build the SaaS demo warehouse');
            console.log('  cc-auditor ask "question"            answer a question, record lineage');
            console.log('  cc-auditor explain "SELECT ..."      run the guard alone, no model call');
            console.log('  cc-auditor audit                     verify the hash chain, list entries');
            console.log('  cc-auditor audit --export out.json   write the audit package');
            console.log('  cc-auditor report --out report.md    write a shareable audit report (.md|.html)');
            console.log('  cc-auditor markets <sub>             capital-markets surveillance demo');
            console.log('  cc-auditor enron <sub>               synthetic Enron reporting-gap demo');
            console.log('  cc-auditor lseg <sub>                LSEG fundamentals warehouse + ingest seam');
            console.log('  cc-auditor controls <sub>            run SOC 2 controls (PASS/EXCEPTION + evidence)');
            console.log('  cc-auditor doctor                    check the install, print the MCP client config');
            console.log('  cc-auditor import <file.csv>         import a buyer CSV from CIVIC_IMPORT_DIR (--map to confirm; --pack municipal|iolta|construction)');
            console.log('  cc-auditor ruleset <sub>             inspect/sign Civic-Chain rulesets (list, show, keygen, sign)');
            console.log('  cc-auditor mcp                       serve the engine over MCP (stdio)');
            console.log('  cc-auditor serve [--port N]          serve the engine over HTTP (needs ENGINE_SERVICE_TOKEN)');
            process.exitCode = command ? 2 : 0;
    }
}

main().catch((error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
});

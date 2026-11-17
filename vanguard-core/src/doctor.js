/**
 * `cc-auditor doctor`: check a fresh install and print the MCP client config.
 *
 * Everything here is local: no network, no subprocess, no credential read. It
 * verifies the runtime, builds the bundled municipal demo into the writable data
 * directory, loads that warehouse through the engine exactly as the MCP server
 * will, and prints a ready-to-paste config. The config points at the data-dir
 * copies (stable) rather than the package (which npx may place read-only or wipe).
 *
 * This replaces the checkout-oriented skills/.../verify-setup.js for the npm path.
 */

import { DatabaseSync } from 'node:sqlite';
import { dataDir, ensureDir, municipalDbPath } from './paths.js';
import { buildMunicipalDemo, municipalAllowlistPath } from './municipal.js';

const PKG = '@civic-chain/auditor';

/**
 * Run the checks and return a structured report. Does not print.
 *
 * @param {object} [options]
 * @param {boolean} [options.rebuild]  rebuild the demo database even if present
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<{ checks: {level: 'ok'|'warn'|'fail', msg: string}[], config: object|null, failures: number, warnings: number }>}
 */
export async function runDoctor({ rebuild = false, env = process.env } = {}) {
    const checks = [];
    const ok = (msg) => checks.push({ level: 'ok', msg });
    const warn = (msg) => checks.push({ level: 'warn', msg });
    const fail = (msg) => checks.push({ level: 'fail', msg });

    // 1. Runtime.
    const major = Number(process.versions.node.split('.')[0]);
    if (major >= 22) ok(`Node ${process.versions.node}`);
    else fail(`Node ${process.versions.node}; the Civic-Chain Auditor needs Node 22+ (it uses the built-in node:sqlite).`);
    try {
        await import('node:sqlite');
        ok('node:sqlite is available');
    } catch {
        fail('node:sqlite could not be loaded. Upgrade to Node 22.13+ (or run with --experimental-sqlite on 22.5–22.12).');
    }

    // 2. Data directory.
    const dir = dataDir({ env });
    try {
        ensureDir(dir);
        ok(`data directory writable: ${dir}`);
    } catch (error) {
        fail(`data directory is not writable (${dir}): ${error.message}`);
    }

    // 3. Build the bundled municipal demo into the data directory. The paths are
    // resolved from the same env so an operator override (CIVIC_DATA_DIR) applies.
    let demo = null;
    try {
        demo = buildMunicipalDemo({ dbPath: municipalDbPath({ env }), allowlistOut: municipalAllowlistPath({ env }), rebuild });
        ok(`municipal demo ${demo.built ? (rebuild ? 'rebuilt' : 'built') : 'present'}: ${demo.dbPath}`);
    } catch (error) {
        fail(`could not build the municipal demo: ${error.message}`);
    }

    // 4. Load that warehouse through the engine, exactly as the MCP server will.
    if (demo) {
        const warehouseEnv = { ...env, CIVIC_DB_PATH: demo.dbPath, CIVIC_ALLOWLIST_PATH: demo.allowlistPath };
        try {
            const { loadCustomWarehouse } = await import('./custom.js');
            const { guard } = await import('./guard.js');
            const { validateNamedQueries } = await import('./named-run.js');
            const custom = loadCustomWarehouse({ env: warehouseEnv });
            const checked = validateNamedQueries(custom, guard);
            const names = Object.keys(custom.queries ?? {});
            ok(`engine loads "${custom.name}": ${names.length} named queries, ${checked} statements guarded`);

            // A guarded smoke read: the demo answers a real question with no model call.
            const db = new DatabaseSync(demo.dbPath, { readOnly: true });
            try {
                const { n } = db.prepare('SELECT COUNT(*) AS n FROM expenditures').get();
                ok(`demo ledger readable: ${n} expenditure rows`);
            } finally {
                db.close();
            }
        } catch (error) {
            fail(`the engine could not load the demo warehouse: ${error.message}`);
        }
    }

    const failures = checks.filter((c) => c.level === 'fail').length;
    const warnings = checks.filter((c) => c.level === 'warn').length;
    const config =
        demo && failures === 0
            ? {
                  mcpServers: {
                      'civic-chain-auditor': {
                          command: 'npx',
                          args: ['-y', PKG, 'mcp'],
                          env: {
                              CIVIC_DB_PATH: demo.dbPath,
                              CIVIC_ALLOWLIST_PATH: demo.allowlistPath,
                              ANTHROPIC_API_KEY: '<optional: only for free-text questions>',
                          },
                      },
                  },
              }
            : null;

    return { checks, config, failures, warnings };
}

/** Format a report for the terminal. Returns the full string. */
export function formatDoctor({ checks, config, failures, warnings }) {
    const glyph = { ok: '✔', warn: '!', fail: '✖' };
    const lines = ['Civic-Chain Auditor doctor (local only: no network, no subprocess, no credential read)', ''];
    for (const c of checks) lines.push(`  ${glyph[c.level]} ${c.msg}`);
    lines.push('');
    if (config) {
        lines.push('MCP client config — paste into one of:');
        lines.push('  Claude Code     .mcp.json in your project root');
        lines.push('  Cursor          .cursor/mcp.json (project) or ~/.cursor/mcp.json (global)');
        lines.push('  Claude Desktop  claude_desktop_config.json');
        lines.push('If the file already has an "mcpServers" object, add only the "civic-chain-auditor" entry.');
        lines.push('');
        lines.push(JSON.stringify(config, null, 2));
        lines.push('');
    }
    if (failures > 0) {
        lines.push(`Result: ${failures} problem(s) to fix above${warnings ? `, ${warnings} warning(s)` : ''}.`);
    } else {
        lines.push(`Result: ready${warnings ? `, with ${warnings} warning(s)` : ''}. Restart your MCP client after adding the config.`);
        lines.push('Try: "How much of the paving grant (G-402) has been spent, by vendor? Include the result hash."');
    }
    return lines.join('\n');
}

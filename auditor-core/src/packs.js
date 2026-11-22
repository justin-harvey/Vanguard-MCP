/**
 * The bundled domain packs, from assets/packs.json (the single source of truth,
 * mirrored into the skill copy and drift-tested). Each pack is a signed ruleset
 * plus a synthetic demo ledger (SQL seed + allow-list), served as a custom
 * warehouse. Groundwork for the multi-pack tooling: `ruleset list` enumerates
 * these, and the skill's verify-setup.js --pack builds any one of them.
 */

import { readFileSync } from 'node:fs';
import { assetPath } from './paths.js';

/** @typedef {{ pack: string, warehouse: string, label: string, rulesetPath: string, sqlPath: string, allowlistPath: string }} Pack */

/**
 * Load the pack registry with every path resolved inside the package.
 * @returns {Pack[]}
 */
export function loadPacks() {
    const manifest = JSON.parse(readFileSync(assetPath('packs.json'), 'utf8'));
    return manifest.packs.map((p) => ({
        pack: p.pack,
        warehouse: p.warehouse,
        label: p.label,
        rulesetPath: assetPath(p.pack, p.ruleset),
        sqlPath: assetPath(p.pack, p.sql),
        allowlistPath: assetPath(p.pack, p.allowlist),
    }));
}

/** Find a pack by its key or its warehouse name (they match today, but either works). */
export function findPack(nameOrWarehouse) {
    return loadPacks().find((p) => p.pack === nameOrWarehouse || p.warehouse === nameOrWarehouse) ?? null;
}

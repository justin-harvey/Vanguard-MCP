/**
 * Build (and, on request, sign) the bundled municipal ruleset.
 *
 * The ruleset's query text is lifted from the municipal allow-list so there is
 * one source of truth for the SQL; S9 just moves the *ownership* of the queries
 * (version, changelog, signature) out of the buyer's access-policy file and into
 * a Civic-Chain artifact. Run with no args to (re)write the ruleset JSON into
 * both asset copies; run with `--sign <private-key.pem>` to also write the
 * detached signatures and the public key.
 *
 *   node scripts/build-municipal-ruleset.js
 *   node scripts/build-municipal-ruleset.js --sign /path/to/civic-chain-ruleset-key.pem
 *
 * The private key never lives in the repo or in CI; it is passed by path here
 * and kept offline. Only the public key and the signatures are committed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRuleset } from '../src/ruleset.js';
import { keyIdOf } from '../src/signing.js';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..');
const assetDirs = [
    join(core, 'assets', 'municipal'),
    join(core, '..', 'skills', 'civic-chain-auditor', 'assets'),
];
const pubKeyDests = [
    join(core, 'assets', 'civic-chain-ruleset-pub.pem'),
    join(core, '..', 'skills', 'civic-chain-auditor', 'assets', 'civic-chain-ruleset-pub.pem'),
];

const CHANGELOG = [
    'municipal-v1: initial Civic-Chain municipal ruleset — grant-status, spending-by-vendor, budget-variance, with integrity (unique, total_matches) and finding (compare) checks.',
];

function buildRulesetJson() {
    // The allow-list under assets/municipal is the canonical query source.
    const allow = JSON.parse(readFileSync(join(assetDirs[0], 'sample_allowlist.json'), 'utf8'));
    const ruleset = { name: 'municipal', version: 'municipal-v1', changelog: CHANGELOG, queries: allow.queries };
    // Stable 2-space JSON with a trailing newline, so the bytes (and therefore
    // the content hash) are reproducible.
    return `${JSON.stringify(ruleset, null, 2)}\n`;
}

const json = buildRulesetJson();
for (const dir of assetDirs) {
    writeFileSync(join(dir, 'ruleset.municipal-v1.json'), json);
}
console.log('Wrote ruleset.municipal-v1.json to both asset copies.');

const signIdx = process.argv.indexOf('--sign');
if (signIdx !== -1) {
    const keyPath = process.argv[signIdx + 1];
    if (!keyPath) throw new Error('--sign needs a path to the private key PEM.');
    const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
    const publicKey = createPublicKey(privateKey);
    const signer = { privateKey, publicKey, keyId: keyIdOf(publicKey) };
    const sig = signRuleset(json, signer);
    const sigBody = `${JSON.stringify(sig, null, 2)}\n`;
    for (const dir of assetDirs) {
        writeFileSync(join(dir, 'ruleset.municipal-v1.json.sig'), sigBody);
    }
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    for (const dest of pubKeyDests) writeFileSync(dest, pubPem);
    console.log(`Signed with key ${signer.keyId}; wrote .sig and the public key to both asset copies.`);
}

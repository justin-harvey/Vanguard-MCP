/**
 * Build (and, on request, sign) the bundled School Districts ruleset.
 *
 * Like the insurance, IOLTA, excise, property/HOA and nonprofit packs, the
 * Schools pack's five controls are authored directly in
 * assets/schools/ruleset.schools-v1.json (the schools allow-list is a pure
 * access policy and carries no queries). This script reads that authored file,
 * re-serialises it canonically (stable 2-space JSON, trailing newline) into both
 * asset copies so their bytes and content hash are reproducible, mirrors the
 * seed and allow-list beside it, and, with `--sign`, writes the detached Ed25519
 * signatures with the offline key.
 *
 *   node scripts/build-schools-ruleset.js
 *   node scripts/build-schools-ruleset.js --sign /path/to/civic-chain-ruleset-key.pem
 *
 * The private key never lives in the repo or in CI; it is passed by path here
 * and kept offline. Only the public key and the signatures are committed.
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRuleset, parseRuleset } from '../src/ruleset.js';
import { keyIdOf } from '../src/signing.js';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..');
const RULESET_FILE = 'ruleset.schools-v1.json';
const MIRRORED = ['sample_schools_ledger.sql', 'sample_schools_allowlist.json'];
const source = join(core, 'assets', 'schools');
const skillAssets = join(core, '..', 'skills', 'civic-chain-auditor', 'assets');
const assetDirs = [source, skillAssets];
const pubKeyDests = [
    join(core, 'assets', 'civic-chain-ruleset-pub.pem'),
    join(skillAssets, 'civic-chain-ruleset-pub.pem'),
];

// The authored ruleset under assets/schools is the source of truth.
const authored = JSON.parse(readFileSync(join(source, RULESET_FILE), 'utf8'));
parseRuleset(authored); // fail loudly here if the authored ruleset is malformed
const json = `${JSON.stringify(authored, null, 2)}\n`;
for (const dir of assetDirs) {
    writeFileSync(join(dir, RULESET_FILE), json);
}
// Mirror the seed and allow-list into the skill package byte-for-byte.
for (const file of MIRRORED) {
    copyFileSync(join(source, file), join(skillAssets, file));
}
console.log(`Wrote ${RULESET_FILE} and mirrored ${MIRRORED.join(', ')} to the skill assets.`);

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
        writeFileSync(join(dir, `${RULESET_FILE}.sig`), sigBody);
    }
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    for (const dest of pubKeyDests) writeFileSync(dest, pubPem);
    console.log(`Signed with key ${signer.keyId}; wrote .sig and the public key to both asset copies.`);
}

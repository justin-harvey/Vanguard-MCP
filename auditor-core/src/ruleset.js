/**
 * Rulesets: the product, separated from the buyer's access policy.
 *
 * S8 and earlier mixed two different things in one allow-list file: the buyer's
 * *access policy* (which tables and columns may be read) and Civic-Chain's
 * *rulesets* (the named queries and their checks — "spent means paid, never
 * void", "paid spending must not exceed the award"). Those have different
 * owners and different trust. The access policy is the buyer's to set. The
 * rulesets are the thing Civic-Chain sells, maintains and stands behind, so they
 * need a version, a changelog, a content hash, and a signature that lets anyone
 * confirm a ruleset is the one Civic-Chain published and has not been edited.
 *
 * This module is that boundary. A ruleset document is:
 *
 *   { "name": "municipal", "version": "municipal-v1",
 *     "changelog": ["v1: grant-status, spending-by-vendor, budget-variance"],
 *     "queries": { ... same shape as named-queries.js ... } }
 *
 * The *content hash* is the SHA-256 of the file's exact bytes, so editing a
 * single byte changes it. A detached signature (`<file>.sig`) carries an
 * Ed25519 signature over that hash, made offline with the Civic-Chain private
 * key; the public key ships in the package. verifyRuleset reports one of:
 *
 *   signed    the bytes match the signature made by the trusted key
 *   modified  a signature exists but does not verify (edited, or wrong key)
 *   unsigned  no signature accompanies the ruleset
 *
 * Every result the engine returns from a ruleset query carries this status and
 * the content hash, so a reader never has to take "this is the official ruleset"
 * on faith. Rulesets ship inside the npm package; a subscription update is a new
 * package version, no registry server.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { sha256hex } from './platform/hash.js';
import { parseQueries, NamedQueryError } from './named-queries.js';
import { signHash, verifyHash, keyIdOf } from './signing.js';
import { assetPath } from './paths.js';

/** The bundled public key the engine trusts as "Civic-Chain". */
export const CIVIC_CHAIN_PUBKEY_PATH = assetPath('civic-chain-ruleset-pub.pem');

const VERSION = /^[a-z0-9][a-z0-9.\-]*$/;

export class RulesetInvalid extends Error {
    constructor(message) {
        super(message);
        this.name = 'RulesetInvalid';
    }
}

/**
 * Validate a parsed ruleset document and return a normalised copy. The queries
 * are validated by the same parser the allow-list uses, so a ruleset cannot
 * define a query the engine would not otherwise accept.
 *
 * @param {unknown} doc
 * @returns {{ name: string, version: string, changelog: string[], queries: object }}
 * @throws {RulesetInvalid}
 */
export function parseRuleset(doc) {
    const fail = (msg) => {
        throw new RulesetInvalid(`Invalid ruleset: ${msg}`);
    };
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('expected a JSON object.');
    const { name, version, changelog = [] } = doc;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) {
        fail('"name" must be lowercase letters, digits or underscores, starting with a letter.');
    }
    if (typeof version !== 'string' || !VERSION.test(version)) {
        fail('"version" must be a version string such as "municipal-v1".');
    }
    if (!Array.isArray(changelog) || changelog.some((c) => typeof c !== 'string')) {
        fail('"changelog" must be an array of strings.');
    }
    let queries;
    try {
        queries = parseQueries(doc.queries);
    } catch (error) {
        if (error instanceof NamedQueryError) fail(error.message);
        throw error;
    }
    if (Object.keys(queries).length === 0) fail('a ruleset must define at least one query.');
    return { name, version, changelog: [...changelog], queries };
}

/** The content hash of a ruleset: SHA-256 of its exact bytes (a Buffer or string). */
export function rulesetContentHash(bytes) {
    return sha256hex(typeof bytes === 'string' ? bytes : bytes.toString('utf8'));
}

/**
 * Sign a ruleset's content hash with a private key, returning the detached
 * signature document. Made offline by the Civic-Chain key; written to
 * `<ruleset>.sig`.
 *
 * @param {Buffer|string} bytes the ruleset file's bytes
 * @param {{ privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject, keyId: string }} signer
 * @returns {{ contentHash: string, keyId: string, signature: string, signedAt: string }}
 */
export function signRuleset(bytes, signer) {
    const contentHash = rulesetContentHash(bytes);
    return {
        contentHash,
        keyId: signer.keyId ?? keyIdOf(signer.publicKey),
        signature: signHash(contentHash, signer.privateKey),
        signedAt: new Date().toISOString(),
    };
}

/**
 * Verify a ruleset's bytes against a detached signature and a trusted public
 * key. Returns a status plus the content hash and the key that was expected.
 *
 * @param {Buffer|string} bytes
 * @param {object|null} sig the parsed `.sig` document, or null when none exists
 * @param {import('node:crypto').KeyObject} trustedPublicKey
 * @returns {{ status: 'signed'|'unsigned'|'modified', contentHash: string, keyId: string, signedBy: string|null }}
 */
export function verifyRuleset(bytes, sig, trustedPublicKey) {
    const contentHash = rulesetContentHash(bytes);
    const trustedKeyId = keyIdOf(trustedPublicKey);
    if (!sig) return { status: 'unsigned', contentHash, keyId: trustedKeyId, signedBy: null };
    // The signature is over the hash of the bytes; a byte edit changes the hash,
    // so the recorded hash no longer matches and the signature no longer verifies.
    const matchesHash = sig.contentHash === contentHash;
    const signedByTrusted = sig.keyId === trustedKeyId;
    const verifies = matchesHash && signedByTrusted && verifyHash(contentHash, sig.signature, trustedPublicKey);
    return {
        status: verifies ? 'signed' : 'modified',
        contentHash,
        keyId: trustedKeyId,
        signedBy: sig.keyId ?? null,
    };
}

/**
 * Load a ruleset from disk: parse it, hash its bytes, and verify its detached
 * signature against the trusted public key. The `.sig` sits beside the ruleset
 * (`<path>.sig`); the trusted key defaults to the bundled Civic-Chain key.
 *
 * @param {string} rulesetPath
 * @param {object} [options]
 * @param {string} [options.sigPath]              defaults to `${rulesetPath}.sig`
 * @param {string} [options.trustedPublicKeyPath] defaults to the bundled Civic-Chain key
 * @returns {{ name: string, version: string, changelog: string[], queries: object,
 *   contentHash: string, signature: { status: string, keyId: string, signedBy: string|null } }}
 * @throws {RulesetInvalid}
 */
export function loadRuleset(rulesetPath, { sigPath = `${rulesetPath}.sig`, trustedPublicKeyPath = CIVIC_CHAIN_PUBKEY_PATH } = {}) {
    if (!existsSync(rulesetPath)) throw new RulesetInvalid(`ruleset not found: ${rulesetPath}`);
    const bytes = readFileSync(rulesetPath);
    let doc;
    try {
        doc = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new RulesetInvalid(`could not parse ${rulesetPath} as JSON: ${error.message}`);
    }
    const parsed = parseRuleset(doc);

    let sig = null;
    if (existsSync(sigPath)) {
        try {
            sig = JSON.parse(readFileSync(sigPath, 'utf8'));
        } catch (error) {
            throw new RulesetInvalid(`could not parse signature ${sigPath}: ${error.message}`);
        }
    }
    // A verifier is only possible when the trusted key is present; without it the
    // ruleset is treated as unsigned rather than falsely "signed".
    let signature;
    if (existsSync(trustedPublicKeyPath)) {
        const trustedPublicKey = createPublicKey(readFileSync(trustedPublicKeyPath, 'utf8'));
        signature = verifyRuleset(bytes, sig, trustedPublicKey);
    } else {
        signature = { status: sig ? 'modified' : 'unsigned', contentHash: rulesetContentHash(bytes), keyId: null, signedBy: sig?.keyId ?? null };
    }
    return { ...parsed, contentHash: signature.contentHash, signature };
}

/** Write a detached signature document beside a ruleset file. Returns the sig path. */
export function writeRulesetSignature(rulesetPath, signer, { sigPath = `${rulesetPath}.sig` } = {}) {
    const sig = signRuleset(readFileSync(rulesetPath), signer);
    writeFileSync(sigPath, `${JSON.stringify(sig, null, 2)}\n`);
    return sigPath;
}

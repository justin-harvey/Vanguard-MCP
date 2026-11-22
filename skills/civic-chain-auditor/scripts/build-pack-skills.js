#!/usr/bin/env node
/**
 * build-pack-skills.js: compose one single-domain Agent Skill per domain pack
 * from this monolithic skill (the shared core + the per-pack reference).
 *
 *   node scripts/build-pack-skills.js [out-dir]   generate every pack skill (default ./dist/skills)
 *   node scripts/build-pack-skills.js --skill iolta [out-dir]   generate just one
 *   node scripts/build-pack-skills.js --list                    list the skills it would emit
 *   node scripts/build-pack-skills.js --zip [out-dir]           generate, then run each folder's package.sh
 *
 * Why generate instead of checking in eight folders: the shared core (Setup,
 * Tools, Workflow, result-reading, claim-discipline/PII, controls/refusals) must
 * stay single-source. This reads that core out of ../SKILL.md at build time and
 * only swaps the domain-specific bits (frontmatter name+description, the intro,
 * the "This pack" pointer, the example prompts) so a core edit propagates to every
 * pack skill with no duplicated maintenance. The listing model is one skill per
 * pack (assets/packs.json `skills[]`); each emitted folder is an Agensi-ready skill.
 *
 * It writes only inside the output directory. No network, no dependencies beyond Node.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const ASSETS = path.join(SKILL_DIR, 'assets');
const REFS = path.join(SKILL_DIR, 'references');
const PACK_REFS = path.join(REFS, 'packs');
const EXAMPLES = path.join(SKILL_DIR, 'examples');

// Shared files every generated skill ships verbatim.
const SHARED_REFS = ['setup.md', 'controls.md', 'refusals.md'];
const SHARED_EXAMPLES = ['03-audit-verification.md']; // audit-chain verification is domain-neutral
const SHARED_ASSETS = ['civic-chain-ruleset-pub.pem']; // public key, needed to verify any ruleset
const SHARED_SCRIPTS = ['verify-setup.js', 'package.sh'];

// Core SKILL.md sections (by `## ` heading) that are domain-neutral and copied as-is.
const SHARED_SECTIONS = ['Tools', 'Workflow', 'Reading a pack result', 'Claim discipline and PII', 'Controls and refusals'];

// ── arguments ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = { outDir: null, only: null, list: false, zip: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--list') args.list = true;
        else if (a === '--zip') args.zip = true;
        else if (a === '--skill') {
            args.only = argv[i + 1];
            i += 1;
        } else if (!a.startsWith('--')) args.outDir = a;
    }
    if (!args.outDir) args.outDir = path.join(SKILL_DIR, 'dist', 'skills');
    return args;
}

// ── manifest ─────────────────────────────────────────────────────────────────
function loadManifest() {
    return JSON.parse(fs.readFileSync(path.join(ASSETS, 'packs.json'), 'utf8'));
}

/** The pack registry entries (warehouse/asset units) named by a skill. */
function skillPacks(manifest, skill) {
    return skill.packs.map((name) => {
        const p = manifest.packs.find((x) => x.pack === name);
        if (!p) throw new Error(`skill "${skill.skill}" names pack "${name}" which is not in packs[]`);
        return p;
    });
}

// ── SKILL.md parsing ───────────────────────────────────────────────────────────
/** Split ../SKILL.md into { frontLines, preamble, sections } for recomposition. */
function parseSkill() {
    const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fm) throw new Error('SKILL.md has no YAML frontmatter block');
    const frontLines = fm[1].split('\n');
    const body = fm[2];

    // Split the body on level-2 headings. The text before the first `## ` is the preamble.
    const parts = body.split(/^## /m);
    const preamble = parts.shift().trim();
    const sections = {};
    for (const part of parts) {
        const nl = part.indexOf('\n');
        const heading = part.slice(0, nl).trim();
        sections[heading] = part.slice(nl + 1).replace(/^\n+/, '').replace(/\s+$/, '');
    }
    return { frontLines, preamble, sections };
}

/** The intro paragraphs after the title's first paragraph — the engine-guarantee prose, kept verbatim. */
function sharedIntroParagraphs(preamble) {
    const paras = preamble.split('\n\n');
    // paras[0] is the `# title`, paras[1] is the domain sentence we replace; keep the rest.
    return paras.slice(2).join('\n\n');
}

/** Pull the full bullet list under a reference file's `## Example prompts` heading. */
function examplePrompts(referenceText) {
    const start = referenceText.indexOf('## Example prompts');
    if (start === -1) return '';
    let rest = referenceText.slice(start + '## Example prompts'.length).replace(/^\n+/, '');
    const next = rest.indexOf('\n## '); // Example prompts is the last section today, but be safe
    if (next !== -1) rest = rest.slice(0, next);
    return rest.trimEnd();
}

// ── frontmatter ───────────────────────────────────────────────────────────────
/** Rebuild the frontmatter with a per-skill name + description, keeping license/metadata/allowed-tools. */
function frontmatterFor(frontLines, skill) {
    const out = [];
    let drop = false; // drop a multi-line value that belongs to a replaced key
    for (const line of frontLines) {
        if (/^name:/.test(line)) {
            out.push(`name: ${skill.skill}-auditor`);
            drop = false;
        } else if (/^description:/.test(line)) {
            out.push(`description: ${skill.description}`);
            drop = false;
        } else if (/^[a-zA-Z[]/.test(line)) {
            // a new top-level key: keep it (and stop dropping)
            out.push(line);
            drop = false;
        } else if (!drop) {
            // a continuation line (indented) of a kept key
            out.push(line);
        }
    }
    return out.join('\n');
}

// ── section templates ──────────────────────────────────────────────────────────
function warehouseList(packs) {
    return packs.map((p) => `\`${p.warehouse}\``).join(' and ');
}

function preambleFor(skill, packs, sharedIntro) {
    // Drop any parenthetical (e.g. "(IOLTA)") and lower-case for the inline domain phrase.
    const domain = skill.title.replace(/\s*\([^)]*\)/g, '').replace(/&/g, 'and').toLowerCase();
    const whs = warehouseList(packs);
    const plural = packs.length > 1 ? 's' : '';
    return [
        `# Civic-Chain Auditor — ${skill.title}`,
        '',
        `Use this skill to audit ${domain}, with every figure traced to source records. It works`,
        `through the Civic-Chain Auditor MCP server, which serves this domain as the ${whs}`,
        `warehouse${plural} with its own named queries (see **This pack** below).`,
        '',
        sharedIntro,
    ].join('\n');
}

function setupFor(skill, packs) {
    const primary = packs[0].warehouse;
    const paras = [
        'Install the engine from npm, then build this pack\'s demo ledger and print the MCP config:',
        ['```bash', 'npx @civic-chain/auditor doctor', `node scripts/verify-setup.js --pack ${primary}`, '```'].join('\n'),
    ];
    if (packs.length > 1) {
        paras.push(
            `This pack carries ${packs.length} warehouses; run \`verify-setup.js --pack <name>\` once per ` +
            `warehouse (${packs.map((p) => `\`${p.warehouse}\``).join(', ')}) to build each demo.`,
        );
    }
    paras.push(
        `\`doctor\` fetches the \`@civic-chain/auditor\` engine from the npm registry and checks the Node 22+\n` +
        `runtime. \`verify-setup.js --pack ${primary}\` then builds the bundled ${skill.title} demo into a local\n` +
        'data directory from its SQL seed (no network, no subprocess, no credential read) and prints a\n' +
        'ready-to-paste `mcpServers` block that launches the server with this pack\'s signed ruleset pinned\n' +
        'via `CIVIC_RULESET_PATH`. Paste that block into your host and restart it.',
        'This one install step is required and justified: the skill is instructions only, while the audit\n' +
        'guarantee (the SQL guard, the grounding check, and the hash-chained log) runs in the\n' +
        '`@civic-chain/auditor` engine package.',
        'Needs Node 22+. Full environment variables, custom-ledger setup, and the complete warehouse and\n' +
        'audit-log reference are in **`references/setup.md`**. In the host, tool names carry the server key\n' +
        'as a prefix (e.g. `mcp__civic-chain-auditor__run_canonical`); below they\'re written bare.',
    );
    return paras.join('\n\n');
}

function thisPackFor(skill, packs) {
    const whs = warehouseList(packs);
    const plural = packs.length > 1 ? 's' : '';
    return [
        `This skill is the **${skill.title}** pack, served by the Civic-Chain Auditor as the ${whs}`,
        `warehouse${plural}. Route its questions through \`run_canonical\` and read each result as in`,
        '**Reading a pack result** above. Its named queries, the exact checks each one carries, its',
        'withheld PII table, and worked example prompts are in **`references/pack.md`**.',
    ].join('\n');
}

function examplePromptsFor(packExamples) {
    const generic = '- "Verify the Civic-Chain Auditor audit log and tell me whether the chain is broken." → `verify_audit`';
    return [
        'The prompts this pack answers (the full set, with the queries they route to, is in `references/pack.md`):',
        '',
        packExamples,
        generic,
        '',
        'Worked transcripts with real figures and hashes are in `examples/`.',
    ].join('\n');
}

// ── workflow wording (light, single-domain) ──────────────────────────────────────
function singleDomainWorkflow(workflow) {
    return workflow
        .replace('Find the pack and its queries in **Domain packs** below.', 'Find its queries in **This pack** below.')
        .replace(/The question matches a domain pack whose warehouse is listed/g,
            'The question is about this pack and its warehouse is configured');
}

// ── assemble one skill ───────────────────────────────────────────────────────────
function composeSkillMd({ frontLines, preamble, sections }, skill, packs) {
    const sharedIntro = sharedIntroParagraphs(preamble);
    const front = frontmatterFor(frontLines, skill);
    const packRefText = fs.readFileSync(path.join(PACK_REFS, skill.reference), 'utf8');

    const blocks = [
        `---\n${front}\n---`,
        preambleFor(skill, packs, sharedIntro),
        `## Setup (once)\n\n${setupFor(skill, packs)}`,
        `## Tools\n\n${sections['Tools']}`,
        `## Workflow\n\n${singleDomainWorkflow(sections['Workflow'])}`,
        `## Reading a pack result\n\n${sections['Reading a pack result']}`,
        `## Claim discipline and PII\n\n${sections['Claim discipline and PII']}`,
        `## This pack\n\n${thisPackFor(skill, packs)}`,
        `## Controls and refusals\n\n${sections['Controls and refusals']}`,
        `## Example prompts\n\n${examplePromptsFor(examplePrompts(packRefText))}`,
    ];
    return blocks.join('\n\n') + '\n';
}

// ── verify-setup.js default-pack rewrite ──────────────────────────────────────────
// The shared verify-setup.js defaults its bare run to the municipal demo; in a
// single-pack folder those municipal files are absent, so point the defaults at
// this pack's own seed. `--pack <warehouse>` works unchanged off the one-entry packs.json.
function verifySetupFor(primaryPack) {
    const src = fs.readFileSync(path.join(SKILL_DIR, 'scripts', 'verify-setup.js'), 'utf8');
    const sqlite = primaryPack.sql.replace(/\.sql$/, '.sqlite');
    return src
        .replace("path.join(ASSETS, 'sample_municipal_budget.sqlite')", `path.join(ASSETS, '${sqlite}')`)
        .replace("path.join(ASSETS, 'sample_municipal_budget.sql')", `path.join(ASSETS, '${primaryPack.sql}')`)
        .replace("path.join(ASSETS, 'sample_allowlist.json')", `path.join(ASSETS, '${primaryPack.allowlist}')`);
}

// ── emit one skill folder ─────────────────────────────────────────────────────────
function writeFileEnsured(dest, content) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
}

function emitSkill(parsed, manifest, skill, outRoot) {
    const packs = skillPacks(manifest, skill);
    const dir = path.join(outRoot, `${skill.skill}-auditor`);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const sub of ['', 'references', 'examples', 'assets', 'scripts']) {
        fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }

    // SKILL.md
    writeFileEnsured(path.join(dir, 'SKILL.md'), composeSkillMd(parsed, skill, packs));

    // README.md — a short registry-facing blurb (buyer sees this first on a listing).
    const readme = [
        `# Civic-Chain Auditor — ${skill.title}`,
        '',
        skill.description,
        '',
        'Install the engine, then build this pack\'s demo and print the MCP config:',
        '',
        '```bash',
        'npx @civic-chain/auditor doctor',
        `node scripts/verify-setup.js --pack ${packs[0].warehouse}`,
        '```',
        '',
        'See `SKILL.md` for the full workflow and `references/pack.md` for this pack\'s queries, checks and example prompts.',
        '',
    ].join('\n');
    writeFileEnsured(path.join(dir, 'README.md'), readme);

    // references/: shared docs verbatim + this pack's reference as pack.md
    for (const f of SHARED_REFS) fs.copyFileSync(path.join(REFS, f), path.join(dir, 'references', f));
    fs.copyFileSync(path.join(PACK_REFS, skill.reference), path.join(dir, 'references', 'pack.md'));

    // examples/: this pack's + the domain-neutral audit-verification one
    for (const f of [...skill.examples, ...SHARED_EXAMPLES]) {
        fs.copyFileSync(path.join(EXAMPLES, f), path.join(dir, 'examples', f));
    }

    // assets/: public key + a one-skill packs.json + each pack's ruleset/sig/sql/allowlist
    for (const f of SHARED_ASSETS) fs.copyFileSync(path.join(ASSETS, f), path.join(dir, 'assets', f));
    const scopedManifest = { comment: `Single ${skill.skill} pack for this standalone skill.`, packs };
    writeFileEnsured(path.join(dir, 'assets', 'packs.json'), JSON.stringify(scopedManifest, null, 2) + '\n');
    for (const p of packs) {
        for (const f of [p.ruleset, `${p.ruleset}.sig`, p.sql, p.allowlist]) {
            fs.copyFileSync(path.join(ASSETS, f), path.join(dir, 'assets', f));
        }
    }

    // scripts/: package.sh verbatim + verify-setup.js with its defaults pointed at this pack
    fs.copyFileSync(path.join(SKILL_DIR, 'scripts', 'package.sh'), path.join(dir, 'scripts', 'package.sh'));
    fs.chmodSync(path.join(dir, 'scripts', 'package.sh'), 0o755);
    writeFileEnsured(path.join(dir, 'scripts', 'verify-setup.js'), verifySetupFor(packs[0]));

    return dir;
}

// ── main ───────────────────────────────────────────────────────────────────────
function main() {
    const args = parseArgs(process.argv.slice(2));
    const manifest = loadManifest();
    let skills = manifest.skills ?? [];
    if (args.only) {
        skills = skills.filter((s) => s.skill === args.only);
        if (skills.length === 0) {
            console.error(`No skill "${args.only}". Available: ${(manifest.skills ?? []).map((s) => s.skill).join(', ')}`);
            process.exit(2);
        }
    }

    if (args.list) {
        console.log(`Pack skills (${skills.length}):\n`);
        for (const s of skills) console.log(`  ${`${s.skill}-auditor`.padEnd(22)} ${s.title}  [${s.packs.join(', ')}]`);
        return;
    }

    const parsed = parseSkill();
    fs.mkdirSync(args.outDir, { recursive: true });
    const built = [];
    for (const skill of skills) {
        const dir = emitSkill(parsed, manifest, skill, args.outDir);
        built.push(dir);
        console.log(`✔ ${skill.skill}-auditor`);
    }
    console.log(`\nWrote ${built.length} pack skill(s) under ${args.outDir}`);

    if (args.zip) {
        console.log('\nPackaging each into an Agensi-ready zip…');
        for (const dir of built) {
            execFileSync('bash', [path.join(dir, 'scripts', 'package.sh')], { stdio: 'inherit' });
        }
    }
}

main();

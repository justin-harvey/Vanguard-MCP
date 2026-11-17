/**
 * Build the in-browser demo bundle.
 *
 * Produces, under site/assets/:
 *   demo-engine.js   the engine + page controller, one ES module, with the
 *                    seed SQL and the allow-list inlined at build time from the
 *                    skill assets so there is a single source of truth
 *   sql-wasm.js      sql.js loader glue (loaded by demo.html as a plain script)
 *   sql-wasm.wasm    the SQLite WebAssembly build, self-hosted (no CDN)
 *
 * Two build-time swaps keep the bundle honest and small:
 *   - platform/hash.js -> platform/hash.browser.js, so hashing uses the
 *     dependency-free pure-JS SHA-256, not node:crypto (which is not in the
 *     browser). sha256.test.js and browser-parity.test.js pin that the hashes
 *     still match the Node engine.
 *   - node-sql-parser -> its SQLite-only build (build/sqlite.js), ~200 KB
 *     instead of every dialect.
 *
 * The built files are committed so Netlify stays build-free (see netlify.toml).
 * Re-run `npm run build:demo` after any change to the engine or the skill
 * assets, and commit the result.
 */

import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..');
const siteAssets = join(core, '..', 'site', 'assets');

const sqljsDist = dirname(require.resolve('sql.js'));
const hashBrowser = join(core, 'src', 'platform', 'hash.browser.js');
const sqliteOnlyParser = require.resolve('node-sql-parser/build/sqlite.js');

mkdirSync(siteAssets, { recursive: true });

const result = await esbuild.build({
    entryPoints: [join(core, 'src', 'browser', 'demo-entry.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    outfile: join(siteAssets, 'demo-engine.js'),
    loader: { '.sql': 'text', '.json': 'json' },
    alias: { 'node-sql-parser': sqliteOnlyParser },
    plugins: [
        {
            name: 'hash-browser-swap',
            setup(build) {
                build.onResolve({ filter: /platform\/hash\.js$/ }, () => ({ path: hashBrowser }));
            },
        },
    ],
    minify: true,
    legalComments: 'none',
    metafile: true,
});

// Self-host the sql.js loader and WASM; no CDN, so the CSP can stay 'self'.
copyFileSync(join(sqljsDist, 'sql-wasm.js'), join(siteAssets, 'sql-wasm.js'));
copyFileSync(join(sqljsDist, 'sql-wasm.wasm'), join(siteAssets, 'sql-wasm.wasm'));

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const files = [
    ['demo-engine.js', join(siteAssets, 'demo-engine.js')],
    ['sql-wasm.js', join(siteAssets, 'sql-wasm.js')],
    ['sql-wasm.wasm', join(siteAssets, 'sql-wasm.wasm')],
];
let total = 0;
console.log('Built the in-browser demo bundle:');
for (const [label, path] of files) {
    const size = statSync(path).size;
    total += size;
    console.log(`  ${label.padEnd(16)} ${kb(size)}`);
}
console.log(`  ${'total transferred'.padEnd(16)} ${kb(total)} (budget: ~1.5 MB)`);
if (total > 1.5 * 1024 * 1024) {
    console.warn('WARNING: bundle exceeds the ~1.5 MB size budget.');
}

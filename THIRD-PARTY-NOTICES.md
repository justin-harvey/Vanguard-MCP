# Third-party notices

The in-browser demo bundle (`site/assets/demo-engine.js`, `sql-wasm.js`,
`sql-wasm.wasm`), built by `vanguard-core/scripts/build-demo.js`, includes the
following third-party components. Everything else in that bundle is
Civic-Chain's own source (see `LICENSE`), including the SHA-256 implementation
(`vanguard-core/src/platform/sha256.js`), which is original and depends on
nothing.

| Component | Version | License | Use |
|---|---|---|---|
| [sql.js](https://github.com/sql-js/sql.js) | 1.16.0 | MIT | SQLite compiled to WebAssembly; runs the demo query engine in the browser |
| [SQLite](https://www.sqlite.org/) | (as bundled by sql.js) | Public Domain | the SQL engine inside sql.js |
| [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) | 5.4.0 | Apache-2.0 | the guard's SQL parser (SQLite-only build) |
| [big-integer](https://github.com/peterolson/BigInteger.js) | 1.6.52 | Unlicense | transitive dependency of node-sql-parser |

`esbuild` is a build-time-only dependency and is not included in the shipped
bundle.

## License texts

### sql.js — MIT

```
Copyright (c) 2017 sql.js authors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### SQLite — Public Domain

SQLite is in the public domain and carries no restrictions on use. See
<https://www.sqlite.org/copyright.html>.

### node-sql-parser — Apache-2.0

Licensed under the Apache License, Version 2.0. See
<https://www.apache.org/licenses/LICENSE-2.0>.

### big-integer — The Unlicense

Released into the public domain under The Unlicense. See
<https://unlicense.org/>.

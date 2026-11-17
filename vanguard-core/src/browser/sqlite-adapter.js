/**
 * Wrap a loaded sql.js `Database` in the warehouse contract the engine expects:
 * `query(sql, { params }) -> rows[]`, plus `exec(sql)` for seeding.
 *
 * This takes the database instance rather than importing sql.js, so it stays
 * runtime-agnostic: the browser builds the instance from the bundled WASM and
 * the parity test builds it from node_modules, and both get the same adapter.
 *
 * Two parity points with the Node `SqliteWarehouse` (node:sqlite):
 *   - Rows are plain objects of column -> value, matching node:sqlite's shape
 *     after the `{ ...row }` normalisation there.
 *   - sql.js returns integers as JS numbers (not BigInt) by default, so the
 *     largest demo value (240,000,000 cents) stays a number and hashes the same
 *     as node:sqlite's. Do not enable BigInt on the sql.js build.
 */

/**
 * @param {{ run: Function, prepare: Function }} db a sql.js Database
 * @returns {{ exec(sql: string): void, query(sql: string, options?: { params?: Array<string|number|null> }): object[] }}
 */
export function sqljsAdapter(db) {
    return {
        exec(sql) {
            db.run(sql);
        },
        query(sql, { params = [] } = {}) {
            // sql.js binds NULL for undefined; the engine passes explicit nulls
            // for omitted optional parameters, so the two agree.
            const stmt = db.prepare(sql);
            try {
                stmt.bind(params);
                const rows = [];
                while (stmt.step()) rows.push(stmt.getAsObject());
                return rows;
            } finally {
                stmt.free();
            }
        },
    };
}

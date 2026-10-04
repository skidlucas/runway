import type { SqlJsStatic } from "sql.js"

let instance: Promise<SqlJsStatic> | null = null

/** Loads SQLite (WASM) on demand: only the import/export screens need it. */
export const loadSqlJs = () => {
  instance ??= Promise.all([import("sql.js"), import("sql.js/dist/sql-wasm.wasm?url")]).then(([mod, wasm]) =>
    mod.default({ locateFile: () => wasm.default }),
  )
  return instance
}

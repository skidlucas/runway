import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1"
import { Context, Effect, Layer, Schema } from "effect"
export type Orm = DrizzleD1Database

export class DbError extends Schema.TaggedError<DbError>()("DbError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Db extends Context.Service<
  Db,
  {
    readonly orm: Orm
    readonly d1: D1Database
    /** Runs a drizzle (or raw D1) call and turns rejections into a typed DbError. */
    use<A>(f: (orm: Orm, d1: D1Database) => Promise<A>): Effect.Effect<A, DbError>
    /** Executes prepared statements atomically (D1 batches run in one transaction). */
    batch(statements: ReadonlyArray<D1PreparedStatement>): Effect.Effect<void, DbError>
  }
>()("runway/server/db/Db") {
  static layer(d1: D1Database) {
    return Layer.succeed(Db, Db.of(makeDb(d1)))
  }
}

const makeDb = (d1: D1Database): Db["Service"] => {
  const orm = drizzle(d1)
  const use = <A>(f: (orm: Orm, d1: D1Database) => Promise<A>) =>
    Effect.tryPromise({
      try: () => f(orm, d1),
      catch: (cause) => new DbError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
    })
  const batch = (statements: ReadonlyArray<D1PreparedStatement>) =>
    statements.length === 0 ? Effect.void : use((_, raw) => raw.batch([...statements])).pipe(Effect.asVoid)
  return { orm, d1, use, batch }
}

// --- Bulk writes ---------------------------------------------------------------

// D1 caps bound parameters at 100 per statement, which would mean ~7 transaction rows per
// INSERT. Instead, rows travel as a single JSON parameter expanded with json_each(): one
// statement inserts thousands of rows. A bound value is limited to 2 MB, hence the chunking.
const MAX_JSON_BYTES = 1_500_000

/**
 * Builds INSERT statements that write `rows` (arrays aligned with `columns`) through json_each.
 * `mode` controls conflicts on the primary key. `where` (SQL over each JSON row, `value`) keeps
 * only some rows; it can read values a row carries after its columns.
 */
export const bulkInsertStatements = (
  d1: D1Database,
  table: string,
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  mode: "insert" | "ignore" | "replace" = "insert",
  where?: string,
): D1PreparedStatement[] => {
  if (rows.length === 0) return []
  const verb = mode === "ignore" ? "INSERT OR IGNORE" : mode === "replace" ? "INSERT OR REPLACE" : "INSERT"
  const select = columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ")
  const sql = `${verb} INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) SELECT ${select} FROM json_each(?)${where ? ` WHERE ${where}` : ""}`
  return chunkRows(rows).map((chunk) => d1.prepare(sql).bind(JSON.stringify(chunk)))
}

const utf8 = new TextEncoder()

/** Splits rows so that each JSON-encoded chunk stays under the D1 bound value limit (in UTF-8 bytes). */
export const chunkRows = <T>(rows: ReadonlyArray<T>, maxBytes = MAX_JSON_BYTES): T[][] => {
  const chunks: T[][] = []
  let current: T[] = []
  let size = 2
  for (const row of rows) {
    const rowSize = utf8.encode(JSON.stringify(row)).length + 1
    if (current.length > 0 && size + rowSize > maxBytes) {
      chunks.push(current)
      current = []
      size = 2
    }
    current.push(row)
    size += rowSize
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Splits a list of ids for `IN (...)` clauses (D1 allows 100 bound parameters). */
export const chunkIds = <T>(ids: ReadonlyArray<T>, size = 90): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

export const newId = (): string => crypto.randomUUID()

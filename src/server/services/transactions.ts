import { eq, getTableColumns, isNotNull, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, type Result } from "effect"
import { type Day, firstDay, isDay, lastDay } from "~/domain/dates"
import { bulkInsertStatements, chunkIds, chunkRows, Db, type DbError, newId } from "../db/client"
import { IS_INTERNAL_TRANSFER, UNCATEGORIZED } from "../db/predicates"
import { accounts, payees, transactions } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { Payees } from "./payees"
import { Rules } from "./rules"
import { Settings } from "./settings"

export type TxPayeeInput =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "transfer"; readonly accountId: string }
  | { readonly kind: "none" }

export type NewTxRow = typeof transactions.$inferInsert & { createdAt: string }

// Deleted rows go to the trash as JSON, with every column of the table, so that an undo puts
// back exactly what was there.
const ALL_COLUMNS = Object.values(getTableColumns(transactions)).map((c) => c.name)
const ROW_AS_JSON = `json_object(${ALL_COLUMNS.map((c) => `'${c}', ${c}`).join(", ")})`
// A payee or category deleted since the deletion (unused payee cleanup, category removal) is
// dropped from the restored row rather than failing the whole undo on its foreign key.
const ROW_FROM_JSON = ALL_COLUMNS.map((c) =>
  c === "payee_id"
    ? `(SELECT id FROM payees WHERE id = json_extract(row, '$.payee_id'))`
    : c === "category_id"
      ? `(SELECT id FROM categories WHERE id = json_extract(row, '$.category_id'))`
      : `json_extract(row, '$.${c}')`,
).join(", ")
const TRASH_KEPT_MS = 24 * 3600 * 1000

const INSERT_COLUMNS = [
  "id",
  "account_id",
  "date",
  "amount",
  "payee_id",
  "category_id",
  "notes",
  "cleared",
  "reconciled",
  "transfer_id",
  "is_parent",
  "parent_id",
  "imported_payee",
  "schedule_id",
  "imported_id",
  "starting_balance",
  "created_at",
]

const insertValues = (r: NewTxRow): unknown[] => [
  r.id,
  r.accountId,
  r.date,
  r.amount,
  r.payeeId ?? null,
  r.categoryId ?? null,
  r.notes ?? null,
  r.cleared ? 1 : 0,
  r.reconciled ? 1 : 0,
  r.transferId ?? null,
  r.isParent ? 1 : 0,
  r.parentId ?? null,
  r.importedPayee ?? null,
  r.scheduleId ?? null,
  r.importedId ?? null,
  r.startingBalance ? 1 : 0,
  r.createdAt,
]

/**
 * INSERT statements for prepared rows, through json_each: drizzle's multi-row insert binds every
 * column of every row and hits D1's 100-parameter limit from the 7th split line. With `guard`, a
 * row is only written when `guard.where` holds; that SQL reads `guard.of(row)` as `value -> '$[#-1]'`.
 * `mode: "ignore"` skips rows whose id already exists instead of failing the batch.
 */
export const transactionInsertStatements = (
  d1: D1Database,
  rows: ReadonlyArray<NewTxRow>,
  options: {
    readonly guard?: { readonly where: string; readonly of: (row: NewTxRow) => unknown }
    readonly mode?: "insert" | "ignore"
  } = {},
) => {
  const { guard, mode = "insert" } = options
  return bulkInsertStatements(
    d1,
    "transactions",
    INSERT_COLUMNS,
    rows.map((r) => (guard ? [...insertValues(r), guard.of(r)] : insertValues(r))),
    mode,
    guard?.where,
  )
}

export type PreparedTx = { readonly id: string; readonly rows: ReadonlyArray<NewTxRow> }

type SplitInput = { readonly amount: number; readonly categoryId: string | null; readonly notes?: string | null }

export type TxInput = {
  readonly accountId: string
  readonly date: string
  readonly amount: number
  readonly payee: TxPayeeInput
  /** undefined: let rules and payee history decide. null: explicitly uncategorized. */
  readonly categoryId?: string | null
  readonly notes?: string | null
  readonly cleared?: boolean
  readonly splits?: ReadonlyArray<SplitInput>
  readonly importedPayee?: string | null
  readonly scheduleId?: string | null
}

export type TxPatch = {
  readonly accountId?: string
  readonly date?: string
  readonly amount?: number
  readonly payee?: TxPayeeInput
  readonly categoryId?: string | null
  readonly notes?: string | null
  readonly cleared?: boolean
  readonly splits?: ReadonlyArray<SplitInput> | null
}

export type ResolvedPayee = { payeeId: string | null; payeeName: string | null; transferAccountId: string | null }

/** What a transaction would be written with once its payee is resolved and rules have run. */
export type ResolvedEntry = { payeeId: string | null; categoryId: string | null; notes: string | null }

const FUTURE = "Une opération ne peut pas être datée dans le futur : elle devient une échéance"

export type TxRow = {
  id: string
  accountId: string
  accountName: string
  /** The account is off budget: its operations never count in the budget, so they carry no category. */
  offBudget: boolean
  date: string
  amount: number
  payeeId: string | null
  payeeName: string | null
  transferAccountId: string | null
  categoryId: string | null
  categoryName: string | null
  notes: string | null
  cleared: boolean
  reconciled: boolean
  transferId: string | null
  isParent: boolean
  parentId: string | null
  importedPayee: string | null
  scheduleId: string | null
  /** Running balance of the account after this transaction (account view only). */
  balance: number | null
}

export type TxFilter = {
  readonly accountId?: string
  readonly categoryId?: string
  readonly payeeId?: string
  readonly month?: string
  readonly from?: string
  readonly to?: string
  readonly search?: string
  readonly uncategorized?: boolean
  readonly limit?: number
  /** Continues after this row of the previous page (its `next`). */
  readonly after?: TxCursor
}

/**
 * Where the next page starts, in display order. Pages follow one another by position rather than
 * by offset, and carry the running balance so that only the first page sums the history.
 */
export type TxCursor = { readonly date: string; readonly createdAt: string; readonly id: string; readonly balance: number | null }

/**
 * `total` is only counted for the first page: the register keeps it while scrolling, and a count
 * over the whole filter costs as much as the page itself. `next` is null on the last page.
 */
export type TxPage = { rows: TxRow[]; total: number | null; children: Record<string, TxRow[]>; next: TxCursor | null }

const SELECT_ROW = `
  t.id, t.account_id AS accountId, a.name AS accountName, a.off_budget AS offBudget, t.date, t.amount,
  t.payee_id AS payeeId, COALESCE(pa.name, p.name) AS payeeName, p.transfer_account_id AS transferAccountId,
  t.category_id AS categoryId, c.name AS categoryName, t.notes, t.cleared, t.reconciled,
  t.transfer_id AS transferId, t.is_parent AS isParent, t.parent_id AS parentId,
  t.imported_payee AS importedPayee, t.schedule_id AS scheduleId`

const FROM_ROW = `
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN payees p ON p.id = t.payee_id
  LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
  LEFT JOIN categories c ON c.id = t.category_id`

type RawRow = Omit<TxRow, "offBudget" | "cleared" | "reconciled" | "isParent"> & {
  createdAt?: string
  offBudget: number
  cleared: number
  reconciled: number
  isParent: number
}

const toRow = (r: RawRow): TxRow => ({
  ...r,
  offBudget: r.offBudget === 1,
  cleared: r.cleared === 1,
  reconciled: r.reconciled === 1,
  isParent: r.isParent === 1,
  balance: r.balance ?? null,
})

export class Transactions extends Context.Service<
  Transactions,
  {
    list(filter: TxFilter): Effect.Effect<TxPage, DbError>
    get(id: string): Effect.Effect<TxRow, DbError | NotFound>
    create(input: TxInput): Effect.Effect<string, DbError | Invalid | NotFound>
    update(id: string, patch: TxPatch): Effect.Effect<void, DbError | Invalid | NotFound>
    /** Deletes transactions; the returned id undoes it with `restore` for a day. */
    remove(ids: ReadonlyArray<string>): Effect.Effect<{ undoId: string }, DbError | Invalid>
    /** Puts back what a `remove` deleted. Fails once the deletion is too old or already undone. */
    restore(undoId: string): Effect.Effect<{ restored: number }, DbError | Invalid>
    setCleared(ids: ReadonlyArray<string>, cleared: boolean): Effect.Effect<void, DbError>
    setCategory(ids: ReadonlyArray<string>, categoryId: string | null): Effect.Effect<void, DbError>
    /** Payee id that represents "transfer to/from" an account, created on demand. */
    transferPayee(accountId: string): Effect.Effect<string, DbError>
    /** The payee a transaction of `accountId` would get, created on demand for a new name or transfer. */
    resolvePayee(input: TxPayeeInput, accountId: string): Effect.Effect<ResolvedPayee, DbError | Invalid | NotFound>
    /** Payee, category and notes `create` would write for `input` (rules included), without writing it. */
    resolveEntry(input: TxInput): Effect.Effect<ResolvedEntry, DbError | Invalid | NotFound>
    /** Statements deleting transactions with their split lines and transfer mirrors, for a caller's own batch. */
    deleteStatements(ids: ReadonlyArray<string>): ReadonlyArray<D1PreparedStatement>
    /**
     * New transactions computed without writing, for a caller that inserts them in its own batch
     * (`transactionInsertStatements`). Accounts and payees given by id are read once for all the inputs, each
     * of which succeeds or fails on its own. Inputs carry their category: rules are not run.
     */
    prepareMany(
      inputs: ReadonlyArray<TxInput & { readonly categoryId: string | null }>,
    ): Effect.Effect<Array<Result.Result<PreparedTx, DbError | Invalid | NotFound>>, DbError>
  }
>()("runway/server/services/Transactions") {
  static readonly layer = Layer.effect(
    Transactions,
    Effect.gen(function* () {
      const db = yield* Db
      const payeesService = yield* Payees
      const rulesService = yield* Rules
      const settings = yield* Settings

      const list = Effect.fn("Transactions.list")(function* (filter: TxFilter) {
        const where: string[] = []
        const params: unknown[] = []
        // Category-oriented views must see split children (they carry the categories);
        // account-oriented views show parents and hide their children.
        const categoryView = filter.categoryId !== undefined || filter.uncategorized === true
        where.push(categoryView ? "t.is_parent = 0" : "t.parent_id IS NULL")
        if (filter.accountId) {
          where.push("t.account_id = ?")
          params.push(filter.accountId)
        }
        if (filter.categoryId) {
          where.push("t.category_id = ?")
          params.push(filter.categoryId)
        }
        if (filter.uncategorized) where.push(UNCATEGORIZED)
        if (filter.payeeId) {
          where.push("t.payee_id = ?")
          params.push(filter.payeeId)
        }
        if (filter.month) {
          where.push("t.date BETWEEN ? AND ?")
          params.push(firstDay(filter.month), lastDay(filter.month))
        }
        if (filter.from) {
          where.push("t.date >= ?")
          params.push(filter.from)
        }
        if (filter.to) {
          where.push("t.date <= ?")
          params.push(filter.to)
        }
        const search = filter.search?.trim()
        if (search) {
          const like = `%${search.replace(/[%_]/g, "")}%`
          const typedEuros = Number(search.replace(",", ".").replace(/[^\d.-]/g, ""))
          const amountClause = Number.isFinite(typedEuros) && /\d/.test(search) ? " OR ABS(t.amount) = ?" : ""
          where.push(
            `(COALESCE(pa.name, p.name) LIKE ? OR t.notes LIKE ? OR t.imported_payee LIKE ? OR c.name LIKE ?${amountClause})`,
          )
          params.push(like, like, like, like)
          if (amountClause) params.push(Math.round(Math.abs(typedEuros) * 100))
        }
        const withBalance =
          filter.accountId !== undefined &&
          !filter.categoryId &&
          !filter.payeeId &&
          !search &&
          !filter.uncategorized &&
          !filter.month &&
          !filter.from &&
          !filter.to
        // The count reads the filter's rows without the cursor.
        const countWhere = where.length ? `WHERE ${where.join(" AND ")}` : ""
        const countParams = [...params]
        const after = filter.after
        if (after) {
          where.push("(t.date, t.created_at, t.id) < (?, ?, ?)")
          params.push(after.date, after.createdAt, after.id)
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
        const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
        // Only search and "uncategorized" filter on joined columns: otherwise count the bare table.
        const countFrom = search || filter.uncategorized ? FROM_ROW : "FROM transactions t"

        const { rows, total, sum } = yield* db.use(async (_, d1) => {
          const [page, count] = await d1.batch([
            d1
              .prepare(
                `SELECT ${SELECT_ROW}, t.created_at AS createdAt, NULL AS balance ${FROM_ROW} ${whereSql}
                 ORDER BY t.date DESC, t.created_at DESC, t.id DESC LIMIT ?`,
              )
              .bind(...params, limit),
            // On an account's first page the count goes over its whole history: the same pass sums
            // it, which is the balance after the latest operation.
            ...(after
              ? []
              : [
                  d1
                    .prepare(`SELECT COUNT(*) AS n${withBalance ? ", COALESCE(SUM(t.amount), 0) AS sum" : ""} ${countFrom} ${countWhere}`)
                    .bind(...countParams),
                ]),
          ])
          const counted = count?.results?.[0] as { n: number; sum?: number } | undefined
          return {
            rows: (page?.results as RawRow[] | undefined) ?? [],
            total: count ? (counted?.n ?? 0) : null,
            sum: counted?.sum ?? null,
          }
        })

        // Running balance: each row is the one above minus its amount.
        const upTo = !withBalance ? null : after ? after.balance : sum
        if (upTo !== null) {
          let balance = upTo
          for (const row of rows) {
            row.balance = balance
            balance -= row.amount
          }
        }
        const last = rows.at(-1)
        const next: TxCursor | null =
          last && rows.length === limit
            ? { date: last.date, createdAt: last.createdAt ?? "", id: last.id, balance: upTo === null ? null : last.balance! - last.amount }
            : null

        const parentIds = rows.filter((r) => r.isParent === 1).map((r) => r.id)
        const children: Record<string, TxRow[]> = {}
        const childResults =
          parentIds.length === 0
            ? []
            : yield* db.use((_, d1) =>
                d1.batch(
                  chunkIds(parentIds).map((chunk) =>
                    d1
                      .prepare(`SELECT ${SELECT_ROW}, NULL AS balance ${FROM_ROW} WHERE t.parent_id IN (${chunk.map(() => "?").join(",")}) ORDER BY t.amount`)
                      .bind(...chunk),
                  ),
                ),
              )
        for (const child of childResults.flatMap((r) => r.results as RawRow[])) {
          const key = child.parentId ?? ""
          ;(children[key] ??= []).push(toRow(child))
        }
        return { rows: rows.map(toRow), total, children, next }
      })

      const get = Effect.fn("Transactions.get")(function* (id: string) {
        const row = yield* db.use((_, d1) =>
          d1.prepare(`SELECT ${SELECT_ROW}, NULL AS balance ${FROM_ROW} WHERE t.id = ?`).bind(id).first<RawRow>(),
        )
        if (!row) return yield* new NotFound({ entity: "Opération", id })
        return toRow(row)
      })

      const findAccount = (id: string) =>
        db
          .use((orm) => orm.select().from(accounts).where(eq(accounts.id, id)).get())
          .pipe(Effect.flatMap((a) => (a ? Effect.succeed(a) : Effect.fail(new NotFound({ entity: "Compte", id })))))

      const transferPayee = Effect.fn("Transactions.transferPayee")(function* (accountId: string) {
        const existing = yield* db.use((orm) =>
          orm.select({ id: payees.id }).from(payees).where(eq(payees.transferAccountId, accountId)).get(),
        )
        if (existing) return existing.id
        const account = yield* db.use((orm) => orm.select().from(accounts).where(eq(accounts.id, accountId)).get())
        const id = newId()
        yield* db.use((orm) =>
          orm
            .insert(payees)
            .values({ id, name: account?.name ?? "Virement", transferAccountId: accountId })
            .onConflictDoNothing(),
        )
        const created = yield* db.use((orm) =>
          orm.select({ id: payees.id }).from(payees).where(eq(payees.transferAccountId, accountId)).get(),
        )
        return created?.id ?? id
      })

      type Lookup = {
        readonly account: (id: string) => Effect.Effect<typeof accounts.$inferSelect, DbError | NotFound>
        readonly payee: (id: string) => Effect.Effect<typeof payees.$inferSelect | undefined, DbError>
        readonly transferPayee: (accountId: string) => Effect.Effect<string, DbError>
      }
      const live: Lookup = {
        account: findAccount,
        payee: (id) => db.use((orm) => orm.select().from(payees).where(eq(payees.id, id)).get()),
        transferPayee,
      }

      /** Every account and the payees `inputs` refer to, read in one batch. */
      const preloaded = Effect.fn("Transactions.preloaded")(function* (inputs: ReadonlyArray<TxInput>) {
        const payeeIds = inputs.flatMap((i) => (i.payee.kind === "id" ? [i.payee.id] : []))
        const [accountRows, payeeRows] = yield* db.use((orm) =>
          orm.batch([
            orm.select().from(accounts),
            orm
              .select()
              .from(payees)
              .where(or(isNotNull(payees.transferAccountId), sql`${payees.id} IN (SELECT value FROM json_each(${JSON.stringify(payeeIds)}))`)),
          ]),
        )
        const accountsById = new Map(accountRows.map((a) => [a.id, a]))
        const payeesById = new Map(payeeRows.map((p) => [p.id, p]))
        const transferPayees = new Map(payeeRows.flatMap((p) => (p.transferAccountId ? [[p.transferAccountId, p.id] as const] : [])))
        const lookup: Lookup = {
          account: (id) => {
            const account = accountsById.get(id)
            return account ? Effect.succeed(account) : Effect.fail(new NotFound({ entity: "Compte", id }))
          },
          payee: (id) => Effect.succeed(payeesById.get(id)),
          transferPayee: (accountId) => {
            const known = transferPayees.get(accountId)
            return known
              ? Effect.succeed(known)
              : transferPayee(accountId).pipe(Effect.tap((id) => Effect.sync(() => transferPayees.set(accountId, id))))
          },
        }
        return lookup
      })

      const resolvePayee = Effect.fn("Transactions.resolvePayee")(function* (input: TxPayeeInput, accountId: string, lookup: Lookup = live) {
        switch (input.kind) {
          case "none":
            return { payeeId: null, payeeName: null, transferAccountId: null } satisfies ResolvedPayee
          case "name": {
            const name = input.name.trim()
            if (name === "") return { payeeId: null, payeeName: null, transferAccountId: null } satisfies ResolvedPayee
            const ids = yield* payeesService.resolveNames([name])
            return { payeeId: ids.get(name) ?? null, payeeName: name, transferAccountId: null } satisfies ResolvedPayee
          }
          case "id": {
            const payee = yield* lookup.payee(input.id)
            if (!payee) return yield* new NotFound({ entity: "Bénéficiaire", id: input.id })
            if (payee.transferAccountId && payee.transferAccountId === accountId) {
              return yield* new Invalid({ message: "Un virement doit viser un autre compte" })
            }
            return {
              payeeId: payee.id,
              payeeName: payee.name,
              transferAccountId: payee.transferAccountId,
            } satisfies ResolvedPayee
          }
          case "transfer": {
            if (input.accountId === accountId) {
              return yield* new Invalid({ message: "Un virement doit viser un autre compte" })
            }
            const target = yield* lookup.account(input.accountId)
            const payeeId = yield* lookup.transferPayee(target.id)
            return { payeeId, payeeName: target.name, transferAccountId: target.id } satisfies ResolvedPayee
          }
        }
      })

      const validateSplits = (amount: number, splits: ReadonlyArray<SplitInput> | undefined | null) => {
        if (!splits || splits.length === 0) return Effect.void
        if (splits.length < 2) return Effect.fail(new Invalid({ message: "Une ventilation compte au moins deux lignes" }))
        const sum = splits.reduce((acc, s) => acc + s.amount, 0)
        if (sum !== amount) {
          return Effect.fail(new Invalid({ message: "La somme des lignes doit égaler le montant de l'opération" }))
        }
        return Effect.void
      }

      /** Category, payee and notes of a transaction: rules and payee history decide when `input.categoryId` is undefined. */
      const categorize = Effect.fn("Transactions.categorize")(function* (
        input: TxInput,
        account: typeof accounts.$inferSelect,
        payee: ResolvedPayee,
        otherAccount: typeof accounts.$inferSelect | null,
      ) {
        let categoryId: string | null = input.categoryId ?? null
        let payeeId = payee.payeeId
        let notes = input.notes ?? null
        if (otherAccount) {
          // A transfer between two budgeted accounts moves money without spending it.
          if (account.offBudget === otherAccount.offBudget) categoryId = null
        } else if (input.categoryId === undefined && !input.splits?.length) {
          const match = yield* rulesService.matcher
          const out = match({
            payeeName: payee.payeeName,
            importedPayee: input.importedPayee ?? null,
            notes,
            amount: input.amount,
            accountId: account.id,
          })
          categoryId = out.categoryId ?? null
          payeeId = out.payeeId ?? payeeId
          notes = notes ?? out.notes ?? null
          if (!categoryId && payeeId) categoryId = yield* payeesService.suggestCategory(payeeId)
        }
        return { categoryId, payeeId, notes } satisfies ResolvedEntry
      })

      const resolveEntry = Effect.fn("Transactions.resolveEntry")(function* (input: TxInput) {
        const account = yield* findAccount(input.accountId)
        const payee = yield* resolvePayee(input.payee, account.id)
        const otherAccount = payee.transferAccountId ? yield* findAccount(payee.transferAccountId) : null
        return yield* categorize(input, account, payee, otherAccount)
      })

      /**
       * Computes the rows of a transaction (parent, split lines, transfer mirror) without writing.
       * `keep` carries over what a rewritten transaction must not lose: its ids, creation time,
       * bank id (re-import dedupe), opening-balance flag and, for the other side of a transfer that
       * stays on the same account, its status and its own bank id, bank label and notes.
       */
      const buildRows = Effect.fn("Transactions.buildRows")(function* (
        today: Day,
        input: TxInput,
        keep?: {
          id: string
          mirrorId: string | null
          createdAt: string
          reconciled: boolean
          importedId: string | null
          startingBalance: boolean
          mirror: {
            accountId: string
            cleared: boolean
            reconciled: boolean
            importedId: string | null
            importedPayee: string | null
            notes: string | null
          } | null
        },
        lookup: Lookup = live,
      ) {
        if (!isDay(input.date)) return yield* new Invalid({ message: "Date invalide" })
        if (input.date > today) return yield* new Invalid({ message: FUTURE })
        if (!Number.isInteger(input.amount)) return yield* new Invalid({ message: "Montant invalide" })
        const account = yield* lookup.account(input.accountId)
        const payee = yield* resolvePayee(input.payee, account.id, lookup)
        yield* validateSplits(input.amount, input.splits)
        if (payee.transferAccountId && input.splits?.length) {
          return yield* new Invalid({ message: "Un virement ne peut pas être ventilé" })
        }

        const otherAccount = payee.transferAccountId ? yield* lookup.account(payee.transferAccountId) : null
        const { categoryId, payeeId, notes } = yield* categorize(input, account, payee, otherAccount)

        const id = keep?.id ?? newId()
        const isParent = (input.splits?.length ?? 0) > 0
        const createdAt = keep?.createdAt ?? new Date(yield* Clock.currentTimeMillis).toISOString()
        const base = {
          accountId: account.id,
          date: input.date,
          payeeId,
          cleared: input.cleared ?? false,
          reconciled: keep?.reconciled ?? false,
          importedPayee: input.importedPayee ?? null,
          scheduleId: input.scheduleId ?? null,
          createdAt,
        }
        const rows: NewTxRow[] = [
          {
            ...base,
            id,
            amount: input.amount,
            categoryId: isParent ? null : categoryId,
            notes,
            isParent,
            importedId: keep?.importedId ?? null,
            startingBalance: keep?.startingBalance ?? false,
          },
        ]
        for (const split of input.splits ?? []) {
          rows.push({ ...base, id: newId(), amount: split.amount, categoryId: split.categoryId, notes: split.notes ?? null, parentId: id })
        }
        if (otherAccount) {
          const mirrorId = keep?.mirrorId ?? newId()
          const mirrorStatus = keep?.mirror?.accountId === otherAccount.id ? keep.mirror : null
          const mirrorPayee = yield* lookup.transferPayee(account.id)
          rows[0] = { ...rows[0]!, transferId: mirrorId }
          rows.push({
            id: mirrorId,
            accountId: otherAccount.id,
            date: input.date,
            amount: -input.amount,
            payeeId: mirrorPayee,
            // The off-budget side of a transfer never carries a category.
            categoryId: !otherAccount.offBudget && account.offBudget ? (input.categoryId ?? null) : null,
            notes: mirrorStatus ? mirrorStatus.notes : notes,
            transferId: id,
            cleared: mirrorStatus?.cleared ?? false,
            reconciled: mirrorStatus?.reconciled ?? false,
            importedId: mirrorStatus?.importedId ?? null,
            importedPayee: mirrorStatus?.importedPayee ?? null,
            createdAt,
          })
        }
        return { id, rows }
      })

      const insertStatements = (rows: ReadonlyArray<NewTxRow>) => transactionInsertStatements(db.d1, rows)

      const create = Effect.fn("Transactions.create")(function* (input: TxInput) {
        const { id, rows } = yield* buildRows(yield* settings.today, input)
        yield* db.batch(insertStatements(rows))
        return id
      })

      const prepareMany = Effect.fn("Transactions.prepareMany")(function* (inputs: ReadonlyArray<TxInput>) {
        if (inputs.length === 0) return []
        const [lookup, today] = yield* Effect.all([preloaded(inputs), settings.today], { concurrency: "unbounded" })
        return yield* Effect.forEach(inputs, (input) => Effect.result(buildRows(today, input, undefined, lookup)))
      })

      /** Deletes transactions with their split lines and transfer mirrors (and the mirrors' lines). */
      const deleteStatements = (ids: ReadonlyArray<string>) =>
        chunkRows(ids).flatMap((chunk) => {
          const json = JSON.stringify(chunk)
          const mirrors = "SELECT transfer_id FROM transactions WHERE id IN (SELECT value FROM json_each(?1)) AND transfer_id IS NOT NULL"
          return [
            db.d1.prepare(`DELETE FROM transactions WHERE parent_id IN (${mirrors})`).bind(json),
            db.d1.prepare(`DELETE FROM transactions WHERE id IN (${mirrors})`).bind(json),
            db.d1.prepare("DELETE FROM transactions WHERE parent_id IN (SELECT value FROM json_each(?1))").bind(json),
            db.d1.prepare("DELETE FROM transactions WHERE id IN (SELECT value FROM json_each(?1))").bind(json),
          ]
        })

      type Stored = typeof transactions.$inferSelect

      /** A split line follows its parent's date, payee and account: only its category and notes change. */
      const updateSplitLine = Effect.fn("Transactions.updateSplitLine")(function* (id: string, patch: TxPatch) {
        // Its amount must keep the lines summing to the parent's total: only the parent's editor can change those.
        if (patch.amount !== undefined || patch.date !== undefined || patch.payee !== undefined || patch.accountId !== undefined || patch.splits !== undefined) {
          return yield* new Invalid({ message: "Modifie l'opération ventilée pour changer cette ligne" })
        }
        const values: Partial<typeof transactions.$inferInsert> = {}
        if (patch.categoryId !== undefined) values.categoryId = patch.categoryId
        if (patch.notes !== undefined) values.notes = patch.notes
        if (Object.keys(values).length) {
          yield* db.use((orm) => orm.update(transactions).set(values).where(eq(transactions.id, id)))
        }
      })

      /** Date, amount, category, notes or status: the rows stay, with their split lines and transfer mirror kept in step. */
      const updateInPlace = Effect.fn("Transactions.updateInPlace")(function* (current: Stored, isTransfer: boolean, patch: TxPatch) {
        const id = current.id
        if (current.isParent && patch.amount !== undefined && patch.amount !== current.amount) {
          return yield* new Invalid({ message: "Modifie les lignes de la ventilation pour changer le total" })
        }
        const values: Partial<typeof transactions.$inferInsert> = {}
        if (patch.date !== undefined) values.date = patch.date
        if (patch.amount !== undefined) values.amount = patch.amount
        if (patch.categoryId !== undefined && !current.isParent) {
          // Same rule as `buildRows`: a transfer inside the budget drops any category it is given.
          const internal = patch.categoryId !== null && isTransfer
            ? yield* db.use((_, d1) =>
                d1.prepare(`SELECT ${IS_INTERNAL_TRANSFER} AS internal FROM transactions t WHERE t.id = ?`).bind(id).first<{ internal: number }>(),
              )
            : null
          values.categoryId = internal?.internal === 1 ? null : patch.categoryId
        }
        if (patch.notes !== undefined) values.notes = patch.notes
        if (patch.cleared !== undefined) values.cleared = patch.cleared
        const targets = [
          { where: eq(transactions.id, id), values },
          // Split lines are counted by the budget on their own date: they must move with the parent.
          ...(current.isParent ? [{ where: eq(transactions.parentId, id), values: { date: patch.date, cleared: patch.cleared } }] : []),
          ...(current.transferId
            ? [{ where: eq(transactions.id, current.transferId), values: { amount: patch.amount === undefined ? undefined : -patch.amount, date: patch.date } }]
            : []),
        ]
        const updates = targets.flatMap(({ where, values }) => {
          const defined = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined))
          return Object.keys(defined).length ? [db.orm.update(transactions).set(defined).where(where)] : []
        })
        const [first, ...rest] = updates
        if (first) yield* db.use((orm) => orm.batch([first, ...rest]))
      })

      /** A new payee kind, account or splits: the transaction is rebuilt under the same ids. */
      const rewrite = Effect.fn("Transactions.rewrite")(function* (current: Stored, payeeInput: TxPayeeInput, patch: TxPatch) {
        const id = current.id
        const accountId = patch.accountId ?? current.accountId
        const amount = patch.amount ?? current.amount
        // Structural edits (payee kind, account, splits, transfer amounts) are rewritten as
        // delete + create under the same id so mirrors and children stay consistent.
        const [existingChildren, mirror] = yield* Effect.all(
          [
            current.isParent ? db.use((orm) => orm.select().from(transactions).where(eq(transactions.parentId, id))) : Effect.succeed([]),
            current.transferId
              ? db.use((orm) => orm.select().from(transactions).where(eq(transactions.id, current.transferId!)).get())
              : Effect.succeed(undefined),
          ],
          { concurrency: "unbounded" },
        )
        const splits =
          patch.splits === null
            ? undefined
            : (patch.splits ??
              (current.isParent
                ? existingChildren.map((c) => ({ amount: c.amount, categoryId: c.categoryId, notes: c.notes }))
                : undefined))
        const input: TxInput = {
          accountId,
          date: patch.date ?? current.date,
          amount,
          payee: payeeInput,
          categoryId: patch.categoryId !== undefined ? patch.categoryId : current.categoryId,
          notes: patch.notes !== undefined ? patch.notes : current.notes,
          cleared: patch.cleared ?? current.cleared,
          importedPayee: current.importedPayee,
          scheduleId: current.scheduleId,
          ...(splits ? { splits } : {}),
        }
        // Same ids and creation time, deleted and rewritten in one batch: links and open views stay
        // valid, and a failure leaves the original untouched.
        // An operation already dated in the future (kept from before such dates became schedules)
        // can still be edited without moving it.
        const today = yield* settings.today
        const { rows } = yield* buildRows(current.date > today ? current.date : today, input, {
          id,
          mirrorId: current.transferId,
          createdAt: current.createdAt,
          reconciled: current.reconciled,
          importedId: current.importedId,
          startingBalance: current.startingBalance,
          mirror: mirror
            ? {
                accountId: mirror.accountId,
                cleared: mirror.cleared,
                reconciled: mirror.reconciled,
                importedId: mirror.importedId,
                importedPayee: mirror.importedPayee,
                notes: mirror.notes,
              }
            : null,
        })
        yield* db.batch([...deleteStatements([id]), ...insertStatements(rows)])
      })

      const update = Effect.fn("Transactions.update")(function* (id: string, patch: TxPatch) {
        const current = yield* db.use((orm) => orm.select().from(transactions).where(eq(transactions.id, id)).get())
        if (!current) return yield* new NotFound({ entity: "Opération", id })
        if (current.parentId) return yield* updateSplitLine(id, patch)
        if (patch.date !== undefined && !isDay(patch.date)) return yield* new Invalid({ message: "Date invalide" })
        if (patch.date !== undefined && patch.date > (yield* settings.today)) return yield* new Invalid({ message: FUTURE })

        const currentPayee = current.payeeId
          ? yield* db.use((orm) => orm.select().from(payees).where(eq(payees.id, current.payeeId!)).get())
          : undefined
        const structural = patch.payee !== undefined || patch.accountId !== undefined || patch.splits !== undefined
        if (!structural) return yield* updateInPlace(current, Boolean(currentPayee?.transferAccountId), patch)

        const payeeInput: TxPayeeInput =
          patch.payee ??
          (currentPayee?.transferAccountId
            ? { kind: "transfer", accountId: currentPayee.transferAccountId }
            : current.payeeId
              ? { kind: "id", id: current.payeeId }
              : { kind: "none" })
        return yield* rewrite(current, payeeInput, patch)
      })

      const remove = Effect.fn("Transactions.remove")(function* (ids: ReadonlyArray<string>) {
        if (ids.length === 0) return { undoId: newId() }
        const splitLines = yield* db.use((_, d1) =>
          d1.batch(
            chunkRows(ids).map((chunk) =>
              d1
                .prepare("SELECT COUNT(*) AS n FROM transactions WHERE id IN (SELECT value FROM json_each(?)) AND parent_id IS NOT NULL")
                .bind(JSON.stringify(chunk)),
            ),
          ),
        )
        if (splitLines.some((r) => ((r.results[0] as { n: number } | undefined)?.n ?? 0) > 0)) {
          return yield* new Invalid({ message: "Une ligne de ventilation se supprime depuis l'opération ventilée" })
        }
        const undoId = newId()
        const now = yield* Clock.currentTimeMillis
        // Same rows as `deleteStatements`: the transactions, their split lines, their transfer
        // mirrors and the mirrors' lines.
        const trash = chunkRows(ids).map((chunk) =>
          db.d1
            .prepare(
              `INSERT INTO transaction_trash (undo_id, deleted_at, row)
               SELECT ?2, ?3, ${ROW_AS_JSON} FROM transactions WHERE id IN (
                 SELECT value FROM json_each(?1)
                 UNION SELECT transfer_id FROM transactions WHERE id IN (SELECT value FROM json_each(?1)) AND transfer_id IS NOT NULL
                 UNION SELECT id FROM transactions WHERE parent_id IN (SELECT value FROM json_each(?1))
                 UNION SELECT id FROM transactions WHERE parent_id IN (
                   SELECT transfer_id FROM transactions WHERE id IN (SELECT value FROM json_each(?1)) AND transfer_id IS NOT NULL
                 )
               )`,
            )
            .bind(JSON.stringify(chunk), undoId, now),
        )
        yield* db.batch([
          db.d1.prepare("DELETE FROM transaction_trash WHERE deleted_at < ?").bind(now - TRASH_KEPT_MS),
          ...trash,
          ...deleteStatements(ids),
        ])
        return { undoId }
      })

      const restore = Effect.fn("Transactions.restore")(function* (undoId: string) {
        const now = yield* Clock.currentTimeMillis
        const found = yield* db.use((_, d1) =>
          d1
            .prepare("SELECT COUNT(*) AS n FROM transaction_trash WHERE undo_id = ? AND deleted_at >= ?")
            .bind(undoId, now - TRASH_KEPT_MS)
            .first<{ n: number }>(),
        )
        const restored = found?.n ?? 0
        if (restored === 0) return yield* new Invalid({ message: "Cette suppression ne peut plus être annulée" })
        // A row whose account was deleted since makes the whole batch fail.
        yield* db.batch([
          db.d1
            .prepare(`INSERT OR IGNORE INTO transactions (${ALL_COLUMNS.join(", ")}) SELECT ${ROW_FROM_JSON} FROM transaction_trash WHERE undo_id = ?`)
            .bind(undoId),
          db.d1.prepare("DELETE FROM transaction_trash WHERE undo_id = ?").bind(undoId),
        ])
        return { restored }
      })

      // The lines of a split follow their parent.
      const setCleared = (ids: ReadonlyArray<string>, cleared: boolean) =>
        db.batch(
          chunkIds(ids).map((chunk) => {
            const marks = chunk.map((_, i) => `?${i + 2}`).join(",")
            return db.d1
              .prepare(`UPDATE transactions SET cleared = ?1 WHERE id IN (${marks}) OR (parent_id IS NOT NULL AND parent_id IN (${marks}))`)
              .bind(cleared ? 1 : 0, ...chunk)
          }),
        )

      const setCategory = (ids: ReadonlyArray<string>, categoryId: string | null) =>
        db.batch(
          chunkIds(ids).map((chunk) =>
            db.d1
              .prepare(
                `UPDATE transactions AS t SET category_id = ?1
                 WHERE t.is_parent = 0 AND t.id IN (${chunk.map(() => "?").join(",")}) AND (?1 IS NULL OR NOT ${IS_INTERNAL_TRANSFER})`,
              )
              .bind(categoryId, ...chunk),
          ),
        )

      return Transactions.of({
        list,
        get,
        create,
        update,
        remove,
        restore,
        setCleared,
        setCategory,
        transferPayee,
        resolvePayee,
        resolveEntry,
        deleteStatements,
        prepareMany,
      })
    }),
  )
}


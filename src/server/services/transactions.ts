import { eq, getTableColumns } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { isDay } from "~/domain/dates"
import { bulkInsertStatements, chunkIds, chunkRows, Db, type DbError, newId } from "../db/client"
import { accounts, payees, transactions } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { Payees } from "./payees"
import { Rules } from "./rules"

export type TxPayeeInput =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "transfer"; readonly accountId: string }
  | { readonly kind: "none" }

type NewTxRow = typeof transactions.$inferInsert & { createdAt: string }

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
  "created_at",
]

export type SplitInput = { readonly amount: number; readonly categoryId: string | null; readonly notes?: string | null }

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

export type TxRow = {
  id: string
  accountId: string
  accountName: string
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
  readonly offset?: number
}

export type TxPage = { rows: TxRow[]; total: number; children: Record<string, TxRow[]> }

const SELECT_ROW = `
  t.id, t.account_id AS accountId, a.name AS accountName, t.date, t.amount,
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

type RawRow = Omit<TxRow, "cleared" | "reconciled" | "isParent"> & {
  cleared: number
  reconciled: number
  isParent: number
}

const toRow = (r: RawRow): TxRow => ({
  ...r,
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
    remove(ids: ReadonlyArray<string>): Effect.Effect<{ undoId: string }, DbError>
    /** Puts back what a `remove` deleted. Fails once the deletion is too old or already undone. */
    restore(undoId: string): Effect.Effect<{ restored: number }, DbError | Invalid>
    setCleared(ids: ReadonlyArray<string>, cleared: boolean): Effect.Effect<void, DbError>
    setCategory(ids: ReadonlyArray<string>, categoryId: string | null): Effect.Effect<void, DbError>
    /** Payee id that represents "transfer to/from" an account, created on demand. */
    transferPayee(accountId: string): Effect.Effect<string, DbError>
  }
>()("runway/server/services/Transactions") {
  static readonly layer = Layer.effect(
    Transactions,
    Effect.gen(function* () {
      const db = yield* Db
      const payeesService = yield* Payees
      const rulesService = yield* Rules

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
        if (filter.uncategorized) {
          where.push(
            "t.category_id IS NULL AND a.off_budget = 0 AND t.starting_balance = 0 AND (p.transfer_account_id IS NULL OR EXISTS (SELECT 1 FROM accounts o WHERE o.id = p.transfer_account_id AND o.off_budget = 1))",
          )
        }
        if (filter.payeeId) {
          where.push("t.payee_id = ?")
          params.push(filter.payeeId)
        }
        if (filter.month) {
          where.push("t.date BETWEEN ? AND ?")
          params.push(`${filter.month}-01`, `${filter.month}-31`)
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
          const cents = Number(search.replace(",", ".").replace(/[^\d.-]/g, ""))
          const amountClause = Number.isFinite(cents) && /\d/.test(search) ? " OR ABS(t.amount) = ?" : ""
          where.push(
            `(COALESCE(pa.name, p.name) LIKE ? OR t.notes LIKE ? OR t.imported_payee LIKE ? OR c.name LIKE ?${amountClause})`,
          )
          params.push(like, like, like, like)
          if (amountClause) params.push(Math.round(Math.abs(cents) * 100))
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
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
        const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
        const offset = Math.max(filter.offset ?? 0, 0)
        // Only search and "uncategorized" filter on joined columns: otherwise count the bare table.
        const countFrom = search || filter.uncategorized ? FROM_ROW : "FROM transactions t"

        const { rows, total } = yield* db.use(async (_, d1) => {
          const [page, count] = await d1.batch([
            d1
              .prepare(
                `SELECT ${SELECT_ROW}, t.created_at AS createdAt, NULL AS balance ${FROM_ROW} ${whereSql}
                 ORDER BY t.date DESC, t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
              )
              .bind(...params, limit, offset),
            d1.prepare(`SELECT COUNT(*) AS n ${countFrom} ${whereSql}`).bind(...params),
          ])
          return {
            rows: (page?.results as RawRow[] | undefined) ?? [],
            total: ((count?.results?.[0] as { n: number } | undefined)?.n ?? 0) as number,
          }
        })

        // Running balance: the first row's balance is the sum of everything up to it, then each
        // row below is the one above minus its amount. One indexed sum instead of a window
        // function over the account's whole history.
        const top = rows[0] as (RawRow & { createdAt: string }) | undefined
        if (withBalance && top) {
          const upTo = yield* db.use((_, d1) =>
            d1
              .prepare(
                `SELECT COALESCE(SUM(amount), 0) AS n FROM transactions
                 WHERE account_id = ? AND parent_id IS NULL AND (date, created_at, id) <= (?, ?, ?)`,
              )
              .bind(filter.accountId, top.date, top.createdAt, top.id)
              .first<{ n: number }>(),
          )
          let balance = upTo?.n ?? 0
          for (const row of rows) {
            row.balance = balance
            balance -= row.amount
          }
        }

        const parentIds = rows.filter((r) => r.isParent === 1).map((r) => r.id)
        const children: Record<string, TxRow[]> = {}
        for (const chunk of chunkIds(parentIds)) {
          const childRows = yield* db.use(async (_, d1) => {
            const { results } = await d1
              .prepare(
                `SELECT ${SELECT_ROW}, NULL AS balance ${FROM_ROW} WHERE t.parent_id IN (${chunk.map(() => "?").join(",")}) ORDER BY t.amount`,
              )
              .bind(...chunk)
              .all<RawRow>()
            return results
          })
          for (const child of childRows) {
            const key = child.parentId ?? ""
            ;(children[key] ??= []).push(toRow(child))
          }
        }
        return { rows: rows.map(toRow), total, children }
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

      type ResolvedPayee = { payeeId: string | null; payeeName: string | null; transferAccountId: string | null }

      const resolvePayee = Effect.fn("Transactions.resolvePayee")(function* (input: TxPayeeInput, accountId: string) {
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
            const payee = yield* db.use((orm) => orm.select().from(payees).where(eq(payees.id, input.id)).get())
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
            const target = yield* findAccount(input.accountId)
            const payeeId = yield* transferPayee(target.id)
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

      /**
       * Computes the rows of a transaction (parent, split lines, transfer mirror) without writing.
       * `keep` reuses the ids and creation time of a transaction being rewritten.
       */
      const prepare = Effect.fn("Transactions.prepare")(function* (
        input: TxInput,
        keep?: { id: string; mirrorId: string | null; createdAt: string; reconciled: boolean },
      ) {
        if (!isDay(input.date)) return yield* new Invalid({ message: "Date invalide" })
        if (!Number.isInteger(input.amount)) return yield* new Invalid({ message: "Montant invalide" })
        const account = yield* findAccount(input.accountId)
        const payee = yield* resolvePayee(input.payee, account.id)
        yield* validateSplits(input.amount, input.splits)
        if (payee.transferAccountId && input.splits?.length) {
          return yield* new Invalid({ message: "Un virement ne peut pas être ventilé" })
        }

        let categoryId: string | null = input.categoryId ?? null
        let payeeId = payee.payeeId
        let notes = input.notes ?? null
        let otherAccount: typeof account | null = null
        if (payee.transferAccountId) {
          otherAccount = yield* findAccount(payee.transferAccountId)
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

        const id = keep?.id ?? newId()
        const isParent = (input.splits?.length ?? 0) > 0
        const createdAt = keep?.createdAt ?? new Date().toISOString()
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
        const rows: NewTxRow[] = [{ ...base, id, amount: input.amount, categoryId: isParent ? null : categoryId, notes, isParent }]
        for (const split of input.splits ?? []) {
          rows.push({ ...base, id: newId(), amount: split.amount, categoryId: split.categoryId, notes: split.notes ?? null, parentId: id })
        }
        if (otherAccount) {
          const mirrorId = keep?.mirrorId ?? newId()
          const mirrorPayee = yield* transferPayee(account.id)
          rows[0] = { ...rows[0]!, transferId: mirrorId }
          rows.push({
            id: mirrorId,
            accountId: otherAccount.id,
            date: input.date,
            amount: -input.amount,
            payeeId: mirrorPayee,
            // The off-budget side of a transfer never carries a category.
            categoryId: !otherAccount.offBudget && account.offBudget ? (input.categoryId ?? null) : null,
            notes,
            transferId: id,
            cleared: false,
            createdAt,
          })
        }
        return { id, rows }
      })

      // Through json_each: drizzle's multi-row insert binds every column of every row and hits
      // D1's 100-parameter limit from the 7th split line.
      const insertStatements = (rows: ReadonlyArray<NewTxRow>) =>
        bulkInsertStatements(
          db.d1,
          "transactions",
          INSERT_COLUMNS,
          rows.map((r) => [
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
            r.createdAt,
          ]),
        )

      const create = Effect.fn("Transactions.create")(function* (input: TxInput) {
        const { id, rows } = yield* prepare(input)
        yield* db.batch(insertStatements(rows))
        return id
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

      const update = Effect.fn("Transactions.update")(function* (id: string, patch: TxPatch) {
        const current = yield* db.use((orm) => orm.select().from(transactions).where(eq(transactions.id, id)).get())
        if (!current) return yield* new NotFound({ entity: "Opération", id })
        if (current.parentId) {
          // Editing a split line only touches its own amount, category and notes.
          const values: Partial<typeof transactions.$inferInsert> = {}
          if (patch.categoryId !== undefined) values.categoryId = patch.categoryId
          if (patch.notes !== undefined) values.notes = patch.notes
          if (Object.keys(values).length) {
            yield* db.use((orm) => orm.update(transactions).set(values).where(eq(transactions.id, id)))
          }
          return
        }
        if (patch.date !== undefined && !isDay(patch.date)) return yield* new Invalid({ message: "Date invalide" })

        const accountId = patch.accountId ?? current.accountId
        const amount = patch.amount ?? current.amount
        const currentPayee = current.payeeId
          ? yield* db.use((orm) => orm.select().from(payees).where(eq(payees.id, current.payeeId!)).get())
          : undefined
        const payeeInput: TxPayeeInput =
          patch.payee ??
          (currentPayee?.transferAccountId
            ? { kind: "transfer", accountId: currentPayee.transferAccountId }
            : current.payeeId
              ? { kind: "id", id: current.payeeId }
              : { kind: "none" })

        const structural = patch.payee !== undefined || patch.accountId !== undefined || patch.splits !== undefined

        if (!structural) {
          const values: Partial<typeof transactions.$inferInsert> = {}
          if (patch.date !== undefined) values.date = patch.date
          if (patch.amount !== undefined) values.amount = patch.amount
          if (patch.categoryId !== undefined && !current.isParent) values.categoryId = patch.categoryId
          if (patch.notes !== undefined) values.notes = patch.notes
          if (patch.cleared !== undefined) values.cleared = patch.cleared
          if (current.isParent && patch.amount !== undefined && patch.amount !== current.amount) {
            return yield* new Invalid({ message: "Modifie les lignes de la ventilation pour changer le total" })
          }
          const updates = [
            { where: eq(transactions.id, id), values },
            // Split lines are counted by the budget on their own date: they must move with the parent.
            {
              where: eq(transactions.parentId, id),
              values: current.isParent ? { date: patch.date, cleared: patch.cleared } : {},
            },
            {
              where: eq(transactions.id, current.transferId ?? ""),
              values: current.transferId ? { amount: patch.amount === undefined ? undefined : -patch.amount, date: patch.date } : {},
            },
          ].flatMap(({ where, values }) => {
            const defined = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined))
            return Object.keys(defined).length ? [db.orm.update(transactions).set(defined).where(where)] : []
          })
          const [first, ...rest] = updates
          if (first) yield* db.use((orm) => orm.batch([first, ...rest]))
          return
        }

        // Structural edits (payee kind, account, splits, transfer amounts) are rewritten as
        // delete + create under the same id so mirrors and children stay consistent.
        const existingChildren = current.isParent
          ? yield* db.use((orm) => orm.select().from(transactions).where(eq(transactions.parentId, id)))
          : []
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
        const { rows } = yield* prepare(input, {
          id,
          mirrorId: current.transferId,
          createdAt: current.createdAt,
          reconciled: current.reconciled,
        })
        yield* db.batch([...deleteStatements([id]), ...insertStatements(rows)])
      })

      const remove = Effect.fn("Transactions.remove")(function* (ids: ReadonlyArray<string>) {
        const undoId = newId()
        const now = Date.now()
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
        const found = yield* db.use((_, d1) =>
          d1
            .prepare("SELECT COUNT(*) AS n FROM transaction_trash WHERE undo_id = ? AND deleted_at >= ?")
            .bind(undoId, Date.now() - TRASH_KEPT_MS)
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

      const setCleared = (ids: ReadonlyArray<string>, cleared: boolean) =>
        db.batch(
          chunkIds(ids).map((chunk) =>
            db.d1
              .prepare(`UPDATE transactions SET cleared = ? WHERE id IN (${chunk.map(() => "?").join(",")})`)
              .bind(cleared ? 1 : 0, ...chunk),
          ),
        )

      const setCategory = (ids: ReadonlyArray<string>, categoryId: string | null) =>
        db.batch(
          chunkIds(ids).map((chunk) =>
            db.d1
              .prepare(
                `UPDATE transactions SET category_id = ? WHERE is_parent = 0 AND id IN (${chunk.map(() => "?").join(",")})`,
              )
              .bind(categoryId, ...chunk),
          ),
        )

      return Transactions.of({ list, get, create, update, remove, restore, setCleared, setCategory, transferPayee })
    }),
  )
}


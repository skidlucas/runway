import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { isDay } from "~/domain/dates"
import { chunkIds, Db, type DbError, newId } from "../db/client"
import { accounts, payees, transactions } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { Payees } from "./payees"
import { Rules } from "./rules"

export type TxPayeeInput =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "transfer"; readonly accountId: string }
  | { readonly kind: "none" }

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
    remove(ids: ReadonlyArray<string>): Effect.Effect<void, DbError>
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
        const balanceExpr = withBalance
          ? ", SUM(t.amount) OVER (ORDER BY t.date, t.created_at, t.id ROWS UNBOUNDED PRECEDING) AS balance"
          : ", NULL AS balance"
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
        const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
        const offset = Math.max(filter.offset ?? 0, 0)

        const { rows, total } = yield* db.use(async (_, d1) => {
          const [page, count] = await d1.batch([
            d1
              .prepare(
                `SELECT * FROM (SELECT ${SELECT_ROW}, t.created_at AS createdAt${balanceExpr} ${FROM_ROW} ${whereSql})
                 ORDER BY date DESC, createdAt DESC, id DESC LIMIT ? OFFSET ?`,
              )
              .bind(...params, limit, offset),
            d1.prepare(`SELECT COUNT(*) AS n ${FROM_ROW} ${whereSql}`).bind(...params),
          ])
          return {
            rows: (page?.results as RawRow[] | undefined) ?? [],
            total: ((count?.results?.[0] as { n: number } | undefined)?.n ?? 0) as number,
          }
        })

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

      const create = Effect.fn("Transactions.create")(function* (input: TxInput) {
        if (!isDay(input.date)) return yield* new Invalid({ message: "Date invalide" })
        if (!Number.isInteger(input.amount)) return yield* new Invalid({ message: "Montant invalide" })
        const account = yield* findAccount(input.accountId)
        const payee = yield* resolvePayee(input.payee, account.id)
        yield* validateSplits(input.amount, input.splits)

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

        const id = newId()
        const isParent = (input.splits?.length ?? 0) > 0
        const base = {
          accountId: account.id,
          date: input.date,
          payeeId,
          cleared: input.cleared ?? false,
          importedPayee: input.importedPayee ?? null,
          scheduleId: input.scheduleId ?? null,
        }
        const rows: (typeof transactions.$inferInsert)[] = [
          { ...base, id, amount: input.amount, categoryId: isParent ? null : categoryId, notes, isParent },
        ]
        for (const split of input.splits ?? []) {
          rows.push({
            ...base,
            id: newId(),
            amount: split.amount,
            categoryId: split.categoryId,
            notes: split.notes ?? null,
            parentId: id,
          })
        }
        if (otherAccount) {
          const mirrorId = newId()
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
          })
        }
        yield* db.use((orm) => orm.insert(transactions).values(rows))
        return id
      })

      const deleteWithLinks = (ids: ReadonlyArray<string>) =>
        db.use(async (_, d1) => {
          for (const chunk of chunkIds(ids, 45)) {
            const marks = chunk.map(() => "?").join(",")
            await d1.batch([
              d1
                .prepare(
                  `DELETE FROM transactions WHERE id IN (SELECT transfer_id FROM transactions WHERE id IN (${marks}) AND transfer_id IS NOT NULL)`,
                )
                .bind(...chunk),
              d1.prepare(`DELETE FROM transactions WHERE parent_id IN (${marks})`).bind(...chunk),
              d1.prepare(`DELETE FROM transactions WHERE id IN (${marks})`).bind(...chunk),
            ])
          }
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
          if (Object.keys(values).length) {
            yield* db.use((orm) => orm.update(transactions).set(values).where(eq(transactions.id, id)))
          }
          if (current.transferId && (patch.amount !== undefined || patch.date !== undefined)) {
            const mirror: Partial<typeof transactions.$inferInsert> = {}
            if (patch.amount !== undefined) mirror.amount = -patch.amount
            if (patch.date !== undefined) mirror.date = patch.date
            yield* db.use((orm) => orm.update(transactions).set(mirror).where(eq(transactions.id, current.transferId!)))
          }
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
        yield* validateSplits(input.amount, input.splits)
        const newIdValue = yield* create(input)
        yield* deleteWithLinks([id])
        // Keep the original ids (transaction and transfer mirror) so open views and links stay valid.
        const created = yield* db.use((orm) =>
          orm.select({ transferId: transactions.transferId }).from(transactions).where(eq(transactions.id, newIdValue)).get(),
        )
        yield* db.use(async (_, d1) => {
          const keepMirror = current.transferId && created?.transferId
          await d1.batch([
            ...(keepMirror
              ? [
                  d1.prepare("UPDATE transactions SET id = ? WHERE id = ?").bind(current.transferId, created.transferId),
                  d1.prepare("UPDATE transactions SET transfer_id = ? WHERE id = ?").bind(current.transferId, newIdValue),
                ]
              : []),
            d1.prepare("UPDATE transactions SET id = ? WHERE id = ?").bind(id, newIdValue),
            d1.prepare("UPDATE transactions SET parent_id = ? WHERE parent_id = ?").bind(id, newIdValue),
            d1.prepare("UPDATE transactions SET transfer_id = ? WHERE transfer_id = ?").bind(id, newIdValue),
            d1
              .prepare("UPDATE transactions SET reconciled = ?, created_at = ? WHERE id = ?")
              .bind(current.reconciled ? 1 : 0, current.createdAt, id),
          ])
        })
      })

      const remove = (ids: ReadonlyArray<string>) => deleteWithLinks(ids)

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

      return Transactions.of({ list, get, create, update, remove, setCleared, setCategory, transferPayee })
    }),
  )
}


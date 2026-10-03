import { eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Db, type DbError, newId } from "../db/client"
import { accounts, payees, transactions } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { Categories } from "./categories"
import { Payees } from "./payees"
import { Settings } from "./settings"
import { Transactions } from "./transactions"

export type AccountKind = "checking" | "savings" | "credit" | "investment" | "other"

export type AccountDto = {
  id: string
  name: string
  kind: AccountKind
  offBudget: boolean
  closed: boolean
  inForecast: boolean
  sortOrder: number
  lastReconciledAt: string | null
  balance: number
  clearedBalance: number
  transactionCount: number
}

export type AccountInput = {
  name: string
  kind: AccountKind
  offBudget: boolean
  startingBalance: number
  startingDate?: string
}

export class Accounts extends Context.Service<
  Accounts,
  {
    readonly list: Effect.Effect<AccountDto[], DbError>
    create(input: AccountInput): Effect.Effect<string, DbError | Invalid | NotFound>
    update(
      id: string,
      patch: { name?: string; kind?: AccountKind; offBudget?: boolean; inForecast?: boolean },
    ): Effect.Effect<void, DbError | Invalid | NotFound>
    setClosed(id: string, closed: boolean): Effect.Effect<void, DbError | NotFound>
    /** Deletes an account and its transactions. Transfers to it become plain transactions on the other side. */
    remove(id: string): Effect.Effect<void, DbError | NotFound>
    reorder(ids: ReadonlyArray<string>): Effect.Effect<void, DbError>
    /**
     * Compares the cleared balance with the bank statement, books the difference as an
     * adjustment if needed, then locks every cleared transaction as reconciled.
     */
    reconcile(id: string, statementBalance: number): Effect.Effect<{ adjustment: number }, DbError | NotFound | Invalid>
  }
>()("runway/server/services/Accounts") {
  static readonly layer = Layer.effect(
    Accounts,
    Effect.gen(function* () {
      const db = yield* Db
      const categoriesService = yield* Categories
      const transactionsService = yield* Transactions
      const payeesService = yield* Payees
      const settings = yield* Settings

      const list = db.use(async (_, d1) => {
        const { results } = await d1
          .prepare(
            `SELECT a.id, a.name, a.kind, a.off_budget AS offBudget, a.closed, a.in_forecast AS inForecast,
                    a.sort_order AS sortOrder, a.last_reconciled_at AS lastReconciledAt,
                    COALESCE(SUM(t.amount), 0) AS balance,
                    COALESCE(SUM(CASE WHEN t.cleared = 1 THEN t.amount END), 0) AS clearedBalance,
                    COUNT(t.id) AS transactionCount
             FROM accounts a
             LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
             GROUP BY a.id
             ORDER BY a.closed, a.off_budget, a.sort_order, a.name COLLATE NOCASE`,
          )
          .all<Omit<AccountDto, "offBudget" | "closed" | "inForecast"> & { offBudget: number; closed: number; inForecast: number }>()
        return results.map((r) => ({
          ...r,
          offBudget: r.offBudget === 1,
          closed: r.closed === 1,
          inForecast: r.inForecast === 1,
        }))
      })

      const find = (id: string) =>
        db
          .use((orm) => orm.select().from(accounts).where(eq(accounts.id, id)).get())
          .pipe(Effect.flatMap((a) => (a ? Effect.succeed(a) : Effect.fail(new NotFound({ entity: "Compte", id })))))

      const create = Effect.fn("Accounts.create")(function* (input: AccountInput) {
        const name = input.name.trim()
        if (name === "") return yield* new Invalid({ message: "Le nom du compte est obligatoire" })
        const max = yield* db.use((orm) =>
          orm
            .select({ max: sql<number>`coalesce(max(${accounts.sortOrder}), 0)` })
            .from(accounts)
            .get(),
        )
        const id = newId()
        yield* db.use((orm) =>
          orm.insert(accounts).values({
            id,
            name,
            kind: input.kind,
            offBudget: input.offBudget,
            inForecast: !input.offBudget && (input.kind === "checking" || input.kind === "credit"),
            sortOrder: (max?.max ?? 0) + 1,
          }),
        )
        yield* transactionsService.transferPayee(id)
        if (input.startingBalance !== 0) {
          const categoryId = input.offBudget ? null : yield* categoriesService.startingBalanceCategory
          const payeeIds = yield* payeesService.resolveNames(["Solde initial"])
          const date = input.startingDate ?? (yield* settings.today)
          yield* db.use((orm) =>
            orm.insert(transactions).values({
              id: newId(),
              accountId: id,
              date,
              amount: input.startingBalance,
              payeeId: payeeIds.get("Solde initial") ?? null,
              categoryId,
              cleared: true,
              startingBalance: true,
            }),
          )
        }
        return id
      })

      const update = Effect.fn("Accounts.update")(function* (
        id: string,
        patch: { name?: string; kind?: AccountKind; offBudget?: boolean; inForecast?: boolean },
      ) {
        yield* find(id)
        const values: Partial<typeof accounts.$inferInsert> = {}
        if (patch.name !== undefined) {
          const name = patch.name.trim()
          if (name === "") return yield* new Invalid({ message: "Le nom du compte est obligatoire" })
          values.name = name
        }
        if (patch.kind !== undefined) values.kind = patch.kind
        if (patch.offBudget !== undefined) values.offBudget = patch.offBudget
        if (patch.inForecast !== undefined) values.inForecast = patch.inForecast
        if (Object.keys(values).length === 0) return
        yield* db.use((orm) => orm.update(accounts).set(values).where(eq(accounts.id, id)))
        if (values.name) {
          yield* db.use((orm) => orm.update(payees).set({ name: values.name! }).where(eq(payees.transferAccountId, id)))
        }
      })

      const setClosed = Effect.fn("Accounts.setClosed")(function* (id: string, closed: boolean) {
        yield* find(id)
        yield* db.use((orm) => orm.update(accounts).set({ closed }).where(eq(accounts.id, id)))
      })

      const remove = Effect.fn("Accounts.remove")(function* (id: string) {
        yield* find(id)
        yield* db.use(async (_, d1) => {
          await d1.batch([
            // Mirrors on other accounts lose their link and their transfer payee.
            d1
              .prepare(
                `UPDATE transactions SET transfer_id = NULL, payee_id = NULL
                 WHERE transfer_id IN (SELECT id FROM transactions WHERE account_id = ?)`,
              )
              .bind(id),
            d1.prepare("DELETE FROM transactions WHERE account_id = ?").bind(id),
            d1.prepare("DELETE FROM schedules WHERE account_id = ?").bind(id),
            d1
              .prepare("UPDATE transactions SET payee_id = NULL WHERE payee_id IN (SELECT id FROM payees WHERE transfer_account_id = ?)")
              .bind(id),
            d1.prepare("UPDATE schedules SET payee_id = NULL WHERE payee_id IN (SELECT id FROM payees WHERE transfer_account_id = ?)").bind(id),
            d1.prepare("DELETE FROM payees WHERE transfer_account_id = ?").bind(id),
            d1.prepare("DELETE FROM accounts WHERE id = ?").bind(id),
          ])
        })
      })

      const reorder = (ids: ReadonlyArray<string>) =>
        db.batch(ids.map((id, i) => db.d1.prepare("UPDATE accounts SET sort_order = ? WHERE id = ?").bind(i + 1, id)))

      const reconcile = Effect.fn("Accounts.reconcile")(function* (id: string, statementBalance: number) {
        const account = yield* find(id)
        if (!Number.isInteger(statementBalance)) return yield* new Invalid({ message: "Solde invalide" })
        const row = yield* db.use((_, d1) =>
          d1
            .prepare(
              "SELECT COALESCE(SUM(amount), 0) AS cleared FROM transactions WHERE account_id = ? AND cleared = 1 AND parent_id IS NULL",
            )
            .bind(id)
            .first<{ cleared: number }>(),
        )
        const adjustment = statementBalance - (row?.cleared ?? 0)
        const today = yield* settings.today
        if (adjustment !== 0) {
          const payeeIds = yield* payeesService.resolveNames(["Ajustement de rapprochement"])
          yield* db.use((orm) =>
            orm.insert(transactions).values({
              id: newId(),
              accountId: account.id,
              date: today,
              amount: adjustment,
              payeeId: payeeIds.get("Ajustement de rapprochement") ?? null,
              cleared: true,
              notes: "Écart constaté au rapprochement",
            }),
          )
        }
        yield* db.use(async (_, d1) => {
          await d1.batch([
            d1.prepare("UPDATE transactions SET reconciled = 1 WHERE account_id = ? AND cleared = 1").bind(id),
            d1.prepare("UPDATE accounts SET last_reconciled_at = ? WHERE id = ?").bind(today, id),
          ])
        })
        return { adjustment }
      })

      return Accounts.of({ list, create, update, setClosed, remove, reorder, reconcile })
    }),
  )
}

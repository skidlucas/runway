import { eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import type { AccountKind } from "~/domain/accounts"
import { isDay } from "~/domain/dates"
import { Db, type DbError, newId } from "../db/client"
import { readRule } from "../db/json-columns"
import { IS_INTERNAL_TRANSFER } from "../db/predicates"
import { accounts, payees, rules, transactions } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { Categories } from "./categories"
import { Payees } from "./payees"
import { Settings } from "./settings"

export type { AccountKind }

export type AccountDto = {
  id: string
  name: string
  kind: AccountKind
  offBudget: boolean
  closed: boolean
  inForecast: boolean
  inNetWorth: boolean
  sortOrder: number
  lastReconciledAt: string | null
  /** Every transaction, future-dated ones included. */
  balance: number
  /** Transactions dated today or earlier: what the account holds now. */
  balanceToday: number
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
      patch: { name?: string; kind?: AccountKind; offBudget?: boolean; inForecast?: boolean; inNetWorth?: boolean },
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
      const payeesService = yield* Payees
      const settings = yield* Settings

      const list = Effect.gen(function* () {
        const today = yield* settings.today
        const rows = yield* db.use((_, d1) =>
          d1
            .prepare(
              `SELECT a.id, a.name, a.kind, a.off_budget AS offBudget, a.closed, a.in_forecast AS inForecast,
                      a.in_net_worth AS inNetWorth, a.sort_order AS sortOrder, a.last_reconciled_at AS lastReconciledAt,
                      COALESCE(SUM(t.amount), 0) AS balance,
                      COALESCE(SUM(CASE WHEN t.date <= ? THEN t.amount END), 0) AS balanceToday,
                      COALESCE(SUM(CASE WHEN t.cleared = 1 THEN t.amount END), 0) AS clearedBalance,
                      COUNT(t.id) AS transactionCount
               FROM accounts a
               LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
               GROUP BY a.id
               ORDER BY a.closed, a.off_budget, a.sort_order, a.name COLLATE NOCASE`,
            )
            .bind(today)
            .all<
              Omit<AccountDto, "offBudget" | "closed" | "inForecast" | "inNetWorth"> & {
                offBudget: number
                closed: number
                inForecast: number
                inNetWorth: number
              }
            >(),
        )
        return rows.results.map((r) => ({
          ...r,
          offBudget: r.offBudget === 1,
          closed: r.closed === 1,
          inForecast: r.inForecast === 1,
          inNetWorth: r.inNetWorth === 1,
        }))
      }).pipe(Effect.withSpan("Accounts.list"))

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
        const today = yield* settings.today
        const date = input.startingDate ?? today
        if (!isDay(date)) return yield* new Invalid({ message: "Date du solde initial invalide" })
        if (date > today) return yield* new Invalid({ message: "Le solde initial ne peut pas être daté dans le futur" })
        const opening =
          input.startingBalance === 0
            ? null
            : {
                categoryId: input.offBudget ? null : yield* categoriesService.startingBalanceCategory,
                payeeId: (yield* payeesService.resolveNames(["Solde initial"])).get("Solde initial") ?? null,
              }
        const id = newId()
        // Account, transfer payee and opening balance in one transaction: a retry after a failure
        // never leaves an account without its starting balance.
        yield* db.use((orm) =>
          orm.batch([
            orm.insert(accounts).values({
              id,
              name,
              kind: input.kind,
              offBudget: input.offBudget,
              inForecast: !input.offBudget && (input.kind === "checking" || input.kind === "credit"),
              sortOrder: (max?.max ?? 0) + 1,
            }),
            orm.insert(payees).values({ id: newId(), name, transferAccountId: id }).onConflictDoNothing(),
            ...(opening
              ? [
                  orm.insert(transactions).values({
                    id: newId(),
                    accountId: id,
                    date,
                    amount: input.startingBalance,
                    payeeId: opening.payeeId,
                    categoryId: opening.categoryId,
                    cleared: true,
                    startingBalance: true,
                  }),
                ]
              : []),
          ]),
        )
        return id
      })

      const update = Effect.fn("Accounts.update")(function* (
        id: string,
        patch: { name?: string; kind?: AccountKind; offBudget?: boolean; inForecast?: boolean; inNetWorth?: boolean },
      ) {
        const before = yield* find(id)
        const values: Partial<typeof accounts.$inferInsert> = {}
        if (patch.name !== undefined) {
          const name = patch.name.trim()
          if (name === "") return yield* new Invalid({ message: "Le nom du compte est obligatoire" })
          values.name = name
        }
        if (patch.kind !== undefined) values.kind = patch.kind
        if (patch.offBudget !== undefined) values.offBudget = patch.offBudget
        if (patch.inForecast !== undefined) values.inForecast = patch.inForecast
        if (patch.inNetWorth !== undefined) values.inNetWorth = patch.inNetWorth
        if (Object.keys(values).length === 0) return
        yield* db.use((orm) => orm.update(accounts).set(values).where(eq(accounts.id, id)))
        if (values.name) {
          yield* db.use((orm) => orm.update(payees).set({ name: values.name! }).where(eq(payees.transferAccountId, id)))
        }
        if (values.offBudget !== undefined && values.offBudget !== before.offBudget) {
          const startingBalanceCategory = values.offBudget ? null : yield* categoriesService.startingBalanceCategory
          yield* db.batch([
            // The account's transfers follow the rule applied when they are entered: the off-budget
            // side and transfers within the same side carry no category.
            db.d1
              .prepare(
                `UPDATE transactions AS t SET category_id = NULL
                 WHERE t.category_id IS NOT NULL AND t.transfer_id IS NOT NULL
                   AND (t.account_id = ?1 OR t.transfer_id IN (SELECT id FROM transactions WHERE account_id = ?1))
                   AND ((SELECT off_budget FROM accounts WHERE id = t.account_id) = 1 OR ${IS_INTERNAL_TRANSFER})`,
              )
              .bind(id),
            // A starting balance funds the budget only from a budgeted account.
            db.d1
              .prepare("UPDATE transactions SET category_id = ? WHERE account_id = ? AND starting_balance = 1")
              .bind(startingBalanceCategory, id),
          ])
        }
      })

      const setClosed = Effect.fn("Accounts.setClosed")(function* (id: string, closed: boolean) {
        yield* find(id)
        yield* db.use((orm) => orm.update(accounts).set({ closed }).where(eq(accounts.id, id)))
      })

      const remove = Effect.fn("Accounts.remove")(function* (id: string) {
        const account = yield* find(id)
        // Transfers with this account become ordinary operations, paid to or received from a payee
        // named after it.
        const transferred = yield* db.use((_, d1) =>
          d1
            .prepare(
              `SELECT EXISTS (SELECT 1 FROM transactions WHERE transfer_id IN (SELECT id FROM transactions WHERE account_id = ?1))
                   OR EXISTS (SELECT 1 FROM transactions t JOIN payees p ON p.id = t.payee_id WHERE p.transfer_account_id = ?1 AND t.account_id != ?1)
                   OR EXISTS (SELECT 1 FROM schedules s JOIN payees p ON p.id = s.payee_id WHERE p.transfer_account_id = ?1 AND s.account_id != ?1)
                   AS used`,
            )
            .bind(id)
            .first<{ used: number }>(),
        )
        const payeeId = transferred?.used ? ((yield* payeesService.resolveNames([account.name])).get(account.name) ?? null) : null
        const ruleUpdates = (yield* db.use((orm) => orm.select().from(rules).all()))
          .map(readRule)
          .filter((r) => r.conditions.some((c) => c.field === "account" && c.value === id))
          .map((r) => {
            const conditions = r.conditions.filter((c) => !(c.field === "account" && c.value === id))
            // "Account is …" can no longer match: a rule that required it is switched off rather
            // than left to apply to every account.
            const enabled = r.enabled && r.conditionsOp === "or" && conditions.length > 0
            return db.d1
              .prepare("UPDATE rules SET conditions = ?, enabled = ? WHERE id = ?")
              .bind(JSON.stringify(conditions), enabled ? 1 : 0, r.id)
          })
        yield* db.use(async (_, d1) => {
          await d1.batch([
            d1
              .prepare(
                `UPDATE transactions SET transfer_id = NULL, payee_id = ?2
                 WHERE transfer_id IN (SELECT id FROM transactions WHERE account_id = ?1)`,
              )
              .bind(id, payeeId),
            d1.prepare("DELETE FROM transactions WHERE account_id = ?").bind(id),
            d1.prepare("DELETE FROM schedules WHERE account_id = ?").bind(id),
            d1
              .prepare("UPDATE transactions SET payee_id = ?2 WHERE payee_id IN (SELECT id FROM payees WHERE transfer_account_id = ?1)")
              .bind(id, payeeId),
            d1
              .prepare("UPDATE schedules SET payee_id = ?2 WHERE payee_id IN (SELECT id FROM payees WHERE transfer_account_id = ?1)")
              .bind(id, payeeId),
            ...ruleUpdates,
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
        const today = yield* settings.today
        const payeeIds = yield* payeesService.resolveNames(["Ajustement de rapprochement"])
        // The difference is computed inside the batch: submitting the same statement twice books it once.
        const adjustment = yield* db.use(async (_, d1) => {
          const [inserted] = await d1.batch([
            d1
              .prepare(
                `INSERT INTO transactions (id, account_id, date, amount, payee_id, cleared, notes)
                 SELECT ?1, ?2, ?3, ?4 - COALESCE(SUM(amount), 0), ?5, 1, 'Écart constaté au rapprochement'
                 FROM transactions WHERE account_id = ?2 AND cleared = 1 AND parent_id IS NULL
                 HAVING ?4 - COALESCE(SUM(amount), 0) != 0
                 RETURNING amount`,
              )
              .bind(newId(), account.id, today, statementBalance, payeeIds.get("Ajustement de rapprochement") ?? null),
            d1.prepare("UPDATE transactions SET reconciled = 1 WHERE account_id = ? AND cleared = 1").bind(id),
            d1.prepare("UPDATE accounts SET last_reconciled_at = ? WHERE id = ?").bind(today, id),
          ])
          return ((inserted?.results ?? []) as Array<{ amount: number }>)[0]?.amount ?? 0
        })
        return { adjustment }
      })

      return Accounts.of({ list, create, update, setClosed, remove, reorder, reconcile })
    }),
  )
}

import { Context, Effect, Layer } from "effect"
import { type BudgetCell, type BudgetInputs, type BudgetMonth, computeBudget } from "~/domain/budget-engine"
import { addMonths, isMonth, lastDay, type Month } from "~/domain/dates"
import { Db, type DbError } from "../db/client"
import { Invalid } from "../errors"
import { Categories, type CategoryGroupDto } from "./categories"

export type BudgetCategoryRow = {
  id: string
  name: string
  hidden: boolean
  isIncome: boolean
  budgeted: number
  /** Positive amount spent this month (income categories: amount received). */
  spent: number
  available: number
  carryIn: number
  carryover: boolean
  /** Average monthly spending over the 3 previous months, positive. */
  average3: number
  lastMonthBudgeted: number
}

export type BudgetGroupRow = {
  id: string
  name: string
  isIncome: boolean
  hidden: boolean
  budgeted: number
  spent: number
  available: number
  categories: BudgetCategoryRow[]
}

export type BudgetMonthDto = {
  month: Month
  toBudget: number
  income: number
  budgeted: number
  spent: number
  available: number
  fromLastMonth: number
  lastMonthOverspent: number
  buffered: number
  overspentCount: number
  uncategorized: { count: number; amount: number }
  groups: BudgetGroupRow[]
}

export type MoveTarget = { kind: "category"; id: string } | { kind: "toBudget" }

export class Budget extends Context.Service<
  Budget,
  {
    /** Raw engine output for months up to `until` (shared with forecast and insights). */
    compute(until: Month): Effect.Effect<{ months: Map<Month, BudgetMonth>; tree: CategoryGroupDto[] }, DbError>
    month(month: Month): Effect.Effect<BudgetMonthDto, DbError | Invalid>
    setAmount(month: Month, categoryId: string, amount: number): Effect.Effect<void, DbError | Invalid>
    setCarryover(month: Month, categoryId: string, carryover: boolean): Effect.Effect<void, DbError | Invalid>
    /** Bulk fill: copy last month, average of the last N months, or zero everything. */
    fill(
      month: Month,
      mode: { kind: "copyLastMonth" } | { kind: "average"; months: number } | { kind: "zero" } | { kind: "spent" },
      categoryIds?: ReadonlyArray<string>,
    ): Effect.Effect<number, DbError | Invalid>
    move(month: Month, from: MoveTarget, to: MoveTarget, amount: number): Effect.Effect<void, DbError | Invalid>
    setBuffered(month: Month, amount: number): Effect.Effect<void, DbError | Invalid>
  }
>()("runway/server/services/Budget") {
  static readonly layer = Layer.effect(
    Budget,
    Effect.gen(function* () {
      const db = yield* Db
      const categoriesService = yield* Categories

      const loadInputs = (until: Month) =>
        Effect.all([
          categoriesService.tree,
          db.use(async (_, d1) => {
            const [activity, cells, buffers] = await d1.batch([
              d1
                .prepare(
                  `SELECT substr(t.date, 1, 7) AS month, t.category_id AS categoryId, SUM(t.amount) AS total
                   FROM transactions t JOIN accounts a ON a.id = t.account_id
                   WHERE a.off_budget = 0 AND t.is_parent = 0 AND t.category_id IS NOT NULL AND t.date <= ?
                   GROUP BY month, t.category_id`,
                )
                .bind(lastDay(until)),
              d1
                .prepare("SELECT month, category_id AS categoryId, amount, carryover FROM budgets WHERE month <= ?")
                .bind(until),
              d1.prepare("SELECT month, buffered FROM budget_months WHERE month <= ?").bind(until),
            ])
            return {
              activity: (activity?.results ?? []) as Array<{ month: string; categoryId: string; total: number }>,
              cells: (cells?.results ?? []) as Array<{ month: string; categoryId: string; amount: number; carryover: number }>,
              buffers: (buffers?.results ?? []) as Array<{ month: string; buffered: number }>,
            }
          }),
        ]).pipe(
          Effect.map(([tree, raw]) => {
            const activity = new Map<Month, Map<string, number>>()
            for (const r of raw.activity) {
              const m = activity.get(r.month) ?? new Map<string, number>()
              m.set(r.categoryId, r.total)
              activity.set(r.month, m)
            }
            const budgeted = new Map<Month, Map<string, BudgetCell>>()
            for (const r of raw.cells) {
              const m = budgeted.get(r.month) ?? new Map<string, BudgetCell>()
              m.set(r.categoryId, { amount: r.amount, carryover: r.carryover === 1 })
              budgeted.set(r.month, m)
            }
            const inputs: BudgetInputs = {
              categories: tree.flatMap((g) => g.categories.map((c) => ({ id: c.id, isIncome: c.isIncome }))),
              activity,
              budgeted,
              buffered: new Map(raw.buffers.map((b) => [b.month, b.buffered])),
            }
            return { tree, inputs }
          }),
        )

      const compute = (until: Month) =>
        loadInputs(until).pipe(Effect.map(({ tree, inputs }) => ({ tree, months: computeBudget(inputs, until) })))

      const checkMonth = (month: Month) =>
        isMonth(month) ? Effect.void : Effect.fail(new Invalid({ message: `Mois invalide : ${month}` }))

      const month = Effect.fn("Budget.month")(function* (m: Month) {
        yield* checkMonth(m)
        const { tree, months } = yield* compute(m)
        const current = months.get(m)!
        const previous = [1, 2, 3].map((d) => months.get(addMonths(m, -d)))
        const uncategorized = yield* db.use((_, d1) =>
          d1
            .prepare(
              `SELECT COUNT(*) AS count, COALESCE(SUM(t.amount), 0) AS amount
               FROM transactions t JOIN accounts a ON a.id = t.account_id
               LEFT JOIN payees p ON p.id = t.payee_id
               LEFT JOIN accounts o ON o.id = p.transfer_account_id
               WHERE a.off_budget = 0 AND t.is_parent = 0 AND t.category_id IS NULL AND t.starting_balance = 0
                 AND (p.transfer_account_id IS NULL OR o.off_budget = 1)
                 AND t.date BETWEEN ? AND ?`,
            )
            .bind(`${m}-01`, lastDay(m))
            .first<{ count: number; amount: number }>(),
        )

        let overspentCount = 0
        const groups: BudgetGroupRow[] = tree.map((g) => {
          const categories = g.categories.map((c): BudgetCategoryRow => {
            const cell = current.categories.get(c.id)
            const history = previous.map((p) => p?.categories.get(c.id)?.activity ?? 0)
            const average3 = Math.round(-history.reduce((a, b) => a + b, 0) / 3)
            const row = {
              id: c.id,
              name: c.name,
              hidden: c.hidden,
              isIncome: c.isIncome,
              budgeted: cell?.budgeted ?? 0,
              spent: c.isIncome ? (cell?.activity ?? 0) : -(cell?.activity ?? 0),
              available: cell?.available ?? 0,
              carryIn: cell?.carryIn ?? 0,
              carryover: cell?.carryover ?? false,
              average3: c.isIncome ? -average3 : average3,
              lastMonthBudgeted: previous[0]?.categories.get(c.id)?.budgeted ?? 0,
            }
            if (!c.isIncome && row.available < 0) overspentCount++
            return row
          })
          return {
            id: g.id,
            name: g.name,
            isIncome: g.isIncome,
            hidden: g.hidden,
            budgeted: categories.reduce((a, c) => a + c.budgeted, 0),
            spent: categories.reduce((a, c) => a + c.spent, 0),
            available: categories.reduce((a, c) => a + c.available, 0),
            categories,
          }
        })

        return {
          month: m,
          toBudget: current.toBudget,
          income: current.income,
          budgeted: current.totalBudgeted,
          spent: -current.totalActivity,
          available: current.totalAvailable,
          fromLastMonth: current.fromLastMonth,
          lastMonthOverspent: current.lastMonthOverspent,
          buffered: current.buffered,
          overspentCount,
          uncategorized: { count: uncategorized?.count ?? 0, amount: uncategorized?.amount ?? 0 },
          groups,
        } satisfies BudgetMonthDto
      })

      const upsertAmounts = (m: Month, amounts: ReadonlyArray<readonly [string, number]>) =>
        db.batch(
          amounts.length === 0
            ? []
            : [
                db.d1
                  .prepare(
                    `INSERT INTO budgets (month, category_id, amount, carryover)
                     SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                            COALESCE((SELECT b.carryover FROM budgets b
                                      WHERE b.category_id = json_extract(value, '$[0]') AND b.month < ?
                                      ORDER BY b.month DESC LIMIT 1), 0)
                     FROM json_each(?) WHERE true
                     ON CONFLICT(month, category_id) DO UPDATE SET amount = excluded.amount`,
                  )
                  .bind(m, m, JSON.stringify(amounts)),
              ],
        )

      const setAmount = Effect.fn("Budget.setAmount")(function* (m: Month, categoryId: string, amount: number) {
        yield* checkMonth(m)
        if (!Number.isInteger(amount)) return yield* new Invalid({ message: "Montant invalide" })
        yield* upsertAmounts(m, [[categoryId, amount]])
      })

      const setCarryover = Effect.fn("Budget.setCarryover")(function* (
        m: Month,
        categoryId: string,
        carryover: boolean,
      ) {
        yield* checkMonth(m)
        // Like Actual, the choice applies to this month and every later month already budgeted.
        yield* db.batch([
          db.d1
            .prepare(
              `INSERT INTO budgets (month, category_id, amount, carryover) VALUES (?, ?, 0, ?)
               ON CONFLICT(month, category_id) DO UPDATE SET carryover = excluded.carryover`,
            )
            .bind(m, categoryId, carryover ? 1 : 0),
          db.d1
            .prepare("UPDATE budgets SET carryover = ? WHERE category_id = ? AND month > ?")
            .bind(carryover ? 1 : 0, categoryId, m),
        ])
      })

      const fill = Effect.fn("Budget.fill")(function* (
        m: Month,
        mode: { kind: "copyLastMonth" } | { kind: "average"; months: number } | { kind: "zero" } | { kind: "spent" },
        categoryIds?: ReadonlyArray<string>,
      ) {
        yield* checkMonth(m)
        const { tree, months } = yield* compute(m)
        const wanted = categoryIds ? new Set(categoryIds) : null
        const expense = tree
          .filter((g) => !g.isIncome)
          .flatMap((g) => g.categories)
          .filter((c) => !c.hidden && (!wanted || wanted.has(c.id)))
        const amounts = expense.map((c): readonly [string, number] => {
          switch (mode.kind) {
            case "zero":
              return [c.id, 0]
            case "copyLastMonth":
              return [c.id, months.get(addMonths(m, -1))?.categories.get(c.id)?.budgeted ?? 0]
            case "spent":
              return [c.id, Math.max(0, -(months.get(m)?.categories.get(c.id)?.activity ?? 0))]
            case "average": {
              const n = Math.min(Math.max(mode.months, 1), 24)
              let total = 0
              for (let i = 1; i <= n; i++) total += months.get(addMonths(m, -i))?.categories.get(c.id)?.activity ?? 0
              // Round to the euro: averages to the cent look like noise in a budget.
              return [c.id, Math.max(0, Math.round(-total / n / 100) * 100)]
            }
          }
        })
        yield* upsertAmounts(m, amounts)
        return amounts.length
      })

      const move = Effect.fn("Budget.move")(function* (m: Month, from: MoveTarget, to: MoveTarget, amount: number) {
        yield* checkMonth(m)
        if (!Number.isInteger(amount) || amount <= 0) return yield* new Invalid({ message: "Montant invalide" })
        if (from.kind === "toBudget" && to.kind === "toBudget") return
        const current = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare("SELECT category_id AS id, amount FROM budgets WHERE month = ?")
            .bind(m)
            .all<{ id: string; amount: number }>()
          return new Map(results.map((r) => [r.id, r.amount]))
        })
        const updates: Array<readonly [string, number]> = []
        if (from.kind === "category") updates.push([from.id, (current.get(from.id) ?? 0) - amount])
        if (to.kind === "category") updates.push([to.id, (current.get(to.id) ?? 0) + amount])
        yield* upsertAmounts(m, updates)
      })

      const setBuffered = Effect.fn("Budget.setBuffered")(function* (m: Month, amount: number) {
        yield* checkMonth(m)
        if (!Number.isInteger(amount) || amount < 0) return yield* new Invalid({ message: "Montant invalide" })
        yield* db.batch([
          db.d1
            .prepare(
              "INSERT INTO budget_months (month, buffered) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET buffered = excluded.buffered",
            )
            .bind(m, amount),
        ])
      })

      return Budget.of({ compute, month, setAmount, setCarryover, fill, move, setBuffered })
    }),
  )
}

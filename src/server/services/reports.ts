import { Context, Effect, Layer } from "effect"
import { addMonths, type Day, type Month, monthRange } from "~/domain/dates"
import { cumulativeByDay, type MonthValue, REPORT_MONTHS, runningBalances, topWithRest } from "~/domain/reports"
import { Db, type DbError } from "../db/client"
import { Invalid } from "../errors"
import { Settings } from "./settings"

export type NetWorthReport = { months: MonthValue[]; current: number; change: number }

export type CashFlowReport = {
  months: Array<{ month: Month; income: number; expenses: number }>
  income: number
  expenses: number
  net: number
}

export type SpendingComparisonReport = {
  month: Month
  previous: Month
  today: Day
  /** Cumulative spending of the current month, one value per elapsed day. */
  current: number[]
  /** Cumulative spending of the previous month, every day. */
  previousSeries: number[]
  /** Spent this month so far, and by the same day last month. */
  total: number
  previousToDate: number
}

export type CategorySpendingReport = {
  from: Month
  to: Month
  rows: Array<{ id: string | null; name: string; group: string | null; amount: number }>
  total: number
}

// Spending and income follow the budget: categorized lines of on-budget accounts. Transfers
// between budget accounts have no category and starting balances are not income.
const BUDGET_LINES = `t.is_parent = 0 AND t.starting_balance = 0 AND a.off_budget = 0`

export class Reports extends Context.Service<
  Reports,
  {
    /** Sum of every account balance at each month end. */
    netWorth(months: number): Effect.Effect<NetWorthReport, DbError | Invalid>
    cashFlow(months: number): Effect.Effect<CashFlowReport, DbError | Invalid>
    readonly spendingComparison: Effect.Effect<SpendingComparisonReport, DbError>
    categorySpending(months: number): Effect.Effect<CategorySpendingReport, DbError | Invalid>
  }
>()("runway/server/services/Reports") {
  static readonly layer = Layer.effect(
    Reports,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings

      /** The last `months` months, the current one included. */
      const window = Effect.fn("Reports.window")(function* (months: number) {
        if (!(REPORT_MONTHS as ReadonlyArray<number>).includes(months)) return yield* new Invalid({ message: "Période invalide" })
        const today = yield* settings.today
        const to = today.slice(0, 7)
        const from = addMonths(to, -(months - 1))
        return { today, from, to, months: monthRange(from, to) }
      })

      const netWorth = Effect.fn("Reports.netWorth")(function* (months: number) {
        const w = yield* window(months)
        const raw = yield* db.use(async (_, d1) => {
          const [opening, monthly] = await d1.batch([
            d1.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE parent_id IS NULL AND date < ?").bind(`${w.from}-01`),
            d1.prepare(
              `SELECT substr(date, 1, 7) AS month, SUM(amount) AS total FROM transactions
               WHERE parent_id IS NULL AND date >= ? AND date <= ? GROUP BY 1`,
            ).bind(`${w.from}-01`, w.today),
          ])
          return {
            opening: ((opening?.results?.[0] as { total: number } | undefined)?.total ?? 0) as number,
            monthly: (monthly?.results ?? []) as Array<{ month: Month; total: number }>,
          }
        })
        const series = runningBalances(raw.opening, new Map(raw.monthly.map((m) => [m.month, m.total])), w.months)
        const current = series.at(-1)?.value ?? raw.opening
        // Measured from the balance before the window, so a 1-month window still shows a change.
        return { months: series, current, change: current - raw.opening } satisfies NetWorthReport
      })

      const cashFlow = Effect.fn("Reports.cashFlow")(function* (months: number) {
        const w = yield* window(months)
        const rows = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `SELECT substr(t.date, 1, 7) AS month,
                      SUM(CASE WHEN c.is_income = 1 THEN t.amount ELSE 0 END) AS income,
                      SUM(CASE WHEN c.is_income = 0 THEN -t.amount ELSE 0 END) AS expenses
               FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN categories c ON c.id = t.category_id
               WHERE ${BUDGET_LINES} AND t.date >= ? AND t.date <= ?
               GROUP BY 1`,
            )
            .bind(`${w.from}-01`, w.today)
            .all<{ month: Month; income: number; expenses: number }>()
          return results
        })
        const byMonth = new Map(rows.map((r) => [r.month, r]))
        const series = w.months.map((month) => ({
          month,
          income: byMonth.get(month)?.income ?? 0,
          expenses: byMonth.get(month)?.expenses ?? 0,
        }))
        const income = series.reduce((sum, m) => sum + m.income, 0)
        const expenses = series.reduce((sum, m) => sum + m.expenses, 0)
        return { months: series, income, expenses, net: income - expenses } satisfies CashFlowReport
      })

      const spendingComparison = Effect.gen(function* () {
        const today = yield* settings.today
        const month = today.slice(0, 7)
        const previous = addMonths(month, -1)
        const rows = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `SELECT t.date, SUM(-t.amount) AS total
               FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN categories c ON c.id = t.category_id
               WHERE ${BUDGET_LINES} AND c.is_income = 0 AND t.date >= ? AND t.date <= ?
               GROUP BY t.date`,
            )
            .bind(`${previous}-01`, today)
            .all<{ date: Day; total: number }>()
          return results
        })
        const daily = new Map(rows.map((r) => [r.date, r.total]))
        const current = cumulativeByDay(daily, month, today)
        const previousSeries = cumulativeByDay(daily, previous)
        const total = current.at(-1) ?? 0
        // Same day of the month, clamped to the end of a shorter previous month.
        const previousToDate = previousSeries[Math.min(current.length, previousSeries.length) - 1] ?? 0
        return { month, previous, today, current, previousSeries, total, previousToDate } satisfies SpendingComparisonReport
      })

      const categorySpending = Effect.fn("Reports.categorySpending")(function* (months: number) {
        const w = yield* window(months)
        const rows = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `SELECT c.id, c.name, g.name AS "group", SUM(-t.amount) AS amount
               FROM transactions t JOIN accounts a ON a.id = t.account_id
               JOIN categories c ON c.id = t.category_id JOIN category_groups g ON g.id = c.group_id
               WHERE ${BUDGET_LINES} AND c.is_income = 0 AND t.date >= ? AND t.date <= ?
               GROUP BY c.id HAVING SUM(-t.amount) > 0`,
            )
            .bind(`${w.from}-01`, w.today)
            .all<{ id: string; name: string; group: string; amount: number }>()
          return results
        })
        const top = topWithRest<CategorySpendingReport["rows"][number]>(rows, 7, (amount, n) => ({
          id: null,
          name: `${n} autres catégories`,
          group: null,
          amount,
        }))
        return { from: w.from, to: w.to, rows: top, total: rows.reduce((sum, r) => sum + r.amount, 0) } satisfies CategorySpendingReport
      })

      return Reports.of({ netWorth, cashFlow, spendingComparison, categorySpending })
    }),
  )
}

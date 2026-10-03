import { Context, Effect, Layer } from "effect"
import { isMonth, lastDay, type Month } from "~/domain/dates"
import { computeForecast, type Forecast, type UpcomingItem } from "~/domain/forecast"
import { Db, type DbError } from "../db/client"
import { Invalid, type NotFound } from "../errors"
import { Budget } from "./budget"
import { Schedules } from "./schedules"
import { Settings } from "./settings"

export type ForecastDto = Forecast & { accounts: Array<{ id: string; name: string; balance: number }> }

export class ForecastService extends Context.Service<
  ForecastService,
  {
    month(month?: Month): Effect.Effect<ForecastDto, DbError | Invalid | NotFound>
  }
>()("runway/server/services/Forecast") {
  static readonly layer = Layer.effect(
    ForecastService,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings
      const budget = yield* Budget
      const schedules = yield* Schedules

      const month = Effect.fn("Forecast.month")(function* (requested?: Month) {
        const today = yield* settings.today
        const m = requested ?? today.slice(0, 7)
        if (!isMonth(m)) return yield* new Invalid({ message: "Mois invalide" })
        const start = `${m}-01`
        const end = lastDay(m)

        const [{ months, tree }, raw, occurrences] = yield* Effect.all([
          budget.compute(m),
          db.use(async (_, d1) => {
            const [accounts, opening, daily, future] = await d1.batch([
              d1.prepare(
                `SELECT a.id, a.name, COALESCE(SUM(CASE WHEN t.date <= ? THEN t.amount END), 0) AS balance
                 FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
                 WHERE a.in_forecast = 1 AND a.closed = 0 AND a.off_budget = 0
                 GROUP BY a.id ORDER BY a.sort_order`,
              ).bind(today),
              d1.prepare(
                `SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t JOIN accounts a ON a.id = t.account_id
                 WHERE a.in_forecast = 1 AND a.closed = 0 AND a.off_budget = 0 AND t.parent_id IS NULL AND t.date < ?`,
              ).bind(start),
              d1.prepare(
                `SELECT t.date, SUM(t.amount) AS total FROM transactions t JOIN accounts a ON a.id = t.account_id
                 WHERE a.in_forecast = 1 AND a.closed = 0 AND a.off_budget = 0 AND t.parent_id IS NULL
                   AND t.date BETWEEN ? AND ?
                 GROUP BY t.date ORDER BY t.date`,
              ).bind(start, end),
              d1.prepare(
                `SELECT t.date, t.amount, t.category_id AS categoryId, COALESCE(pa.name, p.name, 'Opération') AS name
                 FROM transactions t JOIN accounts a ON a.id = t.account_id
                 LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
                 WHERE a.in_forecast = 1 AND a.closed = 0 AND a.off_budget = 0 AND t.parent_id IS NULL
                   AND t.date > ? AND t.date <= ?`,
              ).bind(today, end),
            ])
            return {
              accounts: (accounts?.results ?? []) as Array<{ id: string; name: string; balance: number }>,
              opening: ((opening?.results?.[0] as { total: number } | undefined)?.total ?? 0) as number,
              daily: (daily?.results ?? []) as Array<{ date: string; total: number }>,
              future: (future?.results ?? []) as Array<{ date: string; amount: number; categoryId: string | null; name: string }>,
            }
          }),
          schedules.occurrences(today > start ? today : start, end),
        ])

        const forecastAccounts = new Set(raw.accounts.map((a) => a.id))
        const dailyBalances = new Map<string, number>()
        let running = raw.opening
        for (const d of raw.daily) {
          running += d.total
          dailyBalances.set(d.date, running)
        }
        const current = months.get(m)
        const categories = tree.flatMap((g) =>
          g.categories.map((c) => {
            const cell = current?.categories.get(c.id)
            return {
              id: c.id,
              name: c.name,
              isIncome: c.isIncome,
              hidden: c.hidden,
              budgeted: cell?.budgeted ?? 0,
              spent: c.isIncome ? (cell?.activity ?? 0) : -(cell?.activity ?? 0),
              available: cell?.available ?? 0,
            }
          }),
        )
        const upcoming: UpcomingItem[] = [
          ...raw.future.map((t) => ({ ...t, source: "transaction" as const, scheduleId: null })),
          // A scheduled transfer between two forecast accounts moves nothing out of the forecast;
          // one coming from outside it (savings into checking) is money coming in.
          ...occurrences.flatMap((o) => {
            const from = forecastAccounts.has(o.accountId)
            const to = o.transferAccountId !== null && forecastAccounts.has(o.transferAccountId)
            if (from === to) return []
            return [
              {
                date: o.date,
                name: o.name,
                amount: from ? o.amount : -o.amount,
                categoryId: from ? o.categoryId : null,
                source: "schedule" as const,
                scheduleId: o.scheduleId,
              },
            ]
          }),
        ]
        const forecast = computeForecast({
          today,
          month: m,
          categories,
          dailyBalances,
          openingBalance: raw.opening,
          upcoming,
        })
        return { ...forecast, accounts: raw.accounts } satisfies ForecastDto
      })

      return ForecastService.of({ month })
    }),
  )
}


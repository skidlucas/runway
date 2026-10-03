import { Context, Effect, Layer } from "effect"
import { addDays, type Day, isMonth, lastDay, type Month } from "~/domain/dates"
import { computeForecast, type Forecast, type UpcomingItem } from "~/domain/forecast"
import { Db, type DbError } from "../db/client"
import { Invalid, NotFound } from "../errors"
import { type Occurrence, Schedules } from "./schedules"
import { Settings } from "./settings"

export type ForecastAccount = { id: string; name: string; balance: number }

export type ForecastDto = Forecast & {
  accounts: ForecastAccount[]
  /** The single account the forecast is about, or null for every forecast account. */
  accountId: string | null
}

export type ForecastScope = {
  readonly month?: Month
  /** Limits the forecast to one account instead of the accounts flagged "in forecast". */
  readonly accountId?: string
}

export type UpcomingDto = { today: Day; until: Day; items: UpcomingItem[] }

// Either one account (bound as ?1), or the accounts that count as "money available now". Two
// separate statements rather than an OR, so that one account reads through its own index.
const scopeOf = (accountId: string | null, column: "a.id" | "t.account_id") =>
  accountId === null ? "(a.in_forecast = 1 AND a.closed = 0 AND a.off_budget = 0)" : `${column} = ?1`

/**
 * Turns schedule occurrences into money moving in or out of the scoped accounts. A transfer
 * between two scoped accounts moves nothing; one coming from outside (savings into checking)
 * is money coming in.
 */
const scheduledItems = (occurrences: ReadonlyArray<Occurrence>, scoped: ReadonlySet<string>): UpcomingItem[] =>
  occurrences.flatMap((o) => {
    const from = scoped.has(o.accountId)
    const to = o.transferAccountId !== null && scoped.has(o.transferAccountId)
    if (from === to) return []
    return [
      {
        date: o.date,
        name: o.name,
        amount: from ? o.amount : -o.amount,
        categoryId: from ? o.categoryId : null,
        source: "schedule" as const,
        scheduleId: o.scheduleId,
        overdue: o.overdue,
      },
    ]
  })

export class ForecastService extends Context.Service<
  ForecastService,
  {
    month(scope?: ForecastScope): Effect.Effect<ForecastDto, DbError | Invalid | NotFound>
    /** Money expected in or out of the scoped accounts from today to `days` days later. */
    upcoming(args: { accountId?: string; days: number }): Effect.Effect<UpcomingDto, DbError | Invalid>
  }
>()("runway/server/services/Forecast") {
  static readonly layer = Layer.effect(
    ForecastService,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings
      const schedules = yield* Schedules

      const month = Effect.fn("Forecast.month")(function* (scope: ForecastScope = {}) {
        const today = yield* settings.today
        const m = scope.month ?? today.slice(0, 7)
        if (!isMonth(m)) return yield* new Invalid({ message: "Mois invalide" })
        // Today's balance and the operations still to come are only known from the current month on.
        if (m > today.slice(0, 7)) return yield* new Invalid({ message: "La prévision commence au mois en cours" })
        const accountId = scope.accountId ?? null
        const start = `${m}-01`
        const end = lastDay(m)

        const [raw, occurrences] = yield* Effect.all([
          db.use(async (_, d1) => {
            const [accounts, opening, daily, future] = await d1.batch([
              d1.prepare(
                `SELECT a.id, a.name, COALESCE(SUM(CASE WHEN t.date <= ?2 THEN t.amount END), 0) AS balance
                 FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
                 WHERE ${scopeOf(accountId, "a.id")}
                 GROUP BY a.id ORDER BY a.sort_order`,
              ).bind(accountId, today),
              d1.prepare(
                `SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t JOIN accounts a ON a.id = t.account_id
                 WHERE ${scopeOf(accountId, "t.account_id")} AND t.parent_id IS NULL AND t.date < ?2`,
              ).bind(accountId, start),
              d1.prepare(
                `SELECT t.date, SUM(t.amount) AS total FROM transactions t JOIN accounts a ON a.id = t.account_id
                 WHERE ${scopeOf(accountId, "t.account_id")} AND t.parent_id IS NULL AND t.date BETWEEN ?2 AND ?3
                 GROUP BY t.date ORDER BY t.date`,
              ).bind(accountId, start, end),
              d1.prepare(
                `SELECT t.date, t.amount, t.category_id AS categoryId, COALESCE(pa.name, p.name, 'Opération') AS name
                 FROM transactions t JOIN accounts a ON a.id = t.account_id
                 LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
                 WHERE ${scopeOf(accountId, "t.account_id")} AND t.parent_id IS NULL AND t.date > ?2 AND t.date <= ?3`,
              ).bind(accountId, today, end),
            ])
            return {
              accounts: (accounts?.results ?? []) as ForecastAccount[],
              opening: ((opening?.results?.[0] as { total: number } | undefined)?.total ?? 0) as number,
              daily: (daily?.results ?? []) as Array<{ date: string; total: number }>,
              future: (future?.results ?? []) as Array<{ date: string; amount: number; categoryId: string | null; name: string }>,
            }
          }),
          schedules.occurrences(today > start ? today : start, end),
        ], { concurrency: "unbounded" })

        if (accountId !== null && raw.accounts.length === 0) return yield* new NotFound({ entity: "Compte", id: accountId })

        const dailyBalances = new Map<string, number>()
        let running = raw.opening
        for (const d of raw.daily) {
          running += d.total
          dailyBalances.set(d.date, running)
        }
        const upcoming: UpcomingItem[] = [
          ...raw.future.map((t) => ({ ...t, source: "transaction" as const, scheduleId: null, overdue: false })),
          ...scheduledItems(occurrences, new Set(raw.accounts.map((a) => a.id))),
        ]
        const forecast = computeForecast({
          today,
          month: m,
          dailyBalances,
          openingBalance: raw.opening,
          upcoming,
        })
        return {
          ...forecast,
          accounts: raw.accounts.map((a) => ({ id: a.id, name: a.name, balance: a.balance })),
          accountId,
        } satisfies ForecastDto
      })

      const upcoming = Effect.fn("Forecast.upcoming")(function* (args: { accountId?: string; days: number }) {
        if (!Number.isInteger(args.days) || args.days < 0 || args.days > 366) {
          return yield* new Invalid({ message: "Période invalide" })
        }
        const today = yield* settings.today
        const until = addDays(today, args.days)
        const accountId = args.accountId ?? null
        const [raw, occurrences] = yield* Effect.all([
          db.use(async (_, d1) => {
            const [accounts, future] = await d1.batch([
              accountId === null
                ? d1.prepare(`SELECT a.id FROM accounts a WHERE ${scopeOf(null, "a.id")}`)
                : d1.prepare("SELECT a.id FROM accounts a WHERE a.id = ?1").bind(accountId),
              d1.prepare(
                `SELECT t.date, t.amount, t.category_id AS categoryId, COALESCE(pa.name, p.name, 'Opération') AS name
                 FROM transactions t JOIN accounts a ON a.id = t.account_id
                 LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
                 WHERE ${scopeOf(accountId, "t.account_id")} AND t.parent_id IS NULL AND t.date > ?2 AND t.date <= ?3`,
              ).bind(accountId, today, until),
            ])
            return {
              accounts: (accounts?.results ?? []) as Array<{ id: string }>,
              future: (future?.results ?? []) as Array<{ date: string; amount: number; categoryId: string | null; name: string }>,
            }
          }),
          schedules.occurrences(today, until),
        ], { concurrency: "unbounded" })
        const items: UpcomingItem[] = [
          ...raw.future.map((t) => ({ ...t, source: "transaction" as const, scheduleId: null, overdue: false })),
          ...scheduledItems(occurrences, new Set(raw.accounts.map((a) => a.id))),
        ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        return { today, until, items } satisfies UpcomingDto
      })

      return ForecastService.of({ month, upcoming })
    }),
  )
}

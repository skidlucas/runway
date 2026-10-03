import { Context, Effect, Layer } from "effect"
import { addDays, type Day, isMonth, lastDay, type Month } from "~/domain/dates"
import { computeForecast, type Forecast, type UpcomingItem } from "~/domain/forecast"
import { Db, type DbError } from "../db/client"
import { Invalid, NotFound } from "../errors"
import type { AccountKind } from "./accounts"
import { Budget } from "./budget"
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
  /** Defaults to true for every forecast account, and for a single checking or credit account. */
  readonly withBudget?: boolean
}

export type UpcomingDto = { today: Day; until: Day; items: UpcomingItem[] }

type ScopedAccount = ForecastAccount & { kind: AccountKind; offBudget: number }

/** How far back an account's share of the budget spending is measured. */
const SHARE_DAYS = 90

// Either one account, or the accounts that count as "money available now".
const SCOPE = "((?1 IS NULL AND a.in_forecast = 1 AND a.closed = 0 AND a.off_budget = 0) OR a.id = ?1)"

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
      const budget = yield* Budget
      const schedules = yield* Schedules

      const month = Effect.fn("Forecast.month")(function* (scope: ForecastScope = {}) {
        const today = yield* settings.today
        const m = scope.month ?? today.slice(0, 7)
        if (!isMonth(m)) return yield* new Invalid({ message: "Mois invalide" })
        const accountId = scope.accountId ?? null
        const start = `${m}-01`
        const end = lastDay(m)

        const [{ months, tree }, raw, occurrences] = yield* Effect.all([
          budget.compute(m),
          db.use(async (_, d1) => {
            const [accounts, opening, daily, future, share] = await d1.batch([
              d1.prepare(
                `SELECT a.id, a.name, a.kind, a.off_budget AS offBudget,
                        COALESCE(SUM(CASE WHEN t.date <= ?2 THEN t.amount END), 0) AS balance
                 FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
                 WHERE ${SCOPE}
                 GROUP BY a.id ORDER BY a.sort_order`,
              ).bind(accountId, today),
              d1.prepare(
                `SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t JOIN accounts a ON a.id = t.account_id
                 WHERE ${SCOPE} AND t.parent_id IS NULL AND t.date < ?2`,
              ).bind(accountId, start),
              d1.prepare(
                `SELECT t.date, SUM(t.amount) AS total FROM transactions t JOIN accounts a ON a.id = t.account_id
                 WHERE ${SCOPE} AND t.parent_id IS NULL AND t.date BETWEEN ?2 AND ?3
                 GROUP BY t.date ORDER BY t.date`,
              ).bind(accountId, start, end),
              d1.prepare(
                `SELECT t.date, t.amount, t.category_id AS categoryId, COALESCE(pa.name, p.name, 'Opération') AS name
                 FROM transactions t JOIN accounts a ON a.id = t.account_id
                 LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
                 WHERE ${SCOPE} AND t.parent_id IS NULL AND t.date > ?2 AND t.date <= ?3`,
              ).bind(accountId, today, end),
              d1.prepare(
                `SELECT COALESCE(SUM(CASE WHEN a.id = ?1 THEN -t.amount END), 0) AS mine, COALESCE(SUM(-t.amount), 0) AS total
                 FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN categories c ON c.id = t.category_id
                 WHERE t.is_parent = 0 AND t.starting_balance = 0 AND a.off_budget = 0 AND c.is_income = 0
                   AND t.date > ?2 AND t.date <= ?3`,
              ).bind(accountId, addDays(today, -SHARE_DAYS), today),
            ])
            return {
              share: (share?.results?.[0] ?? { mine: 0, total: 0 }) as { mine: number; total: number },
              accounts: (accounts?.results ?? []) as ScopedAccount[],
              opening: ((opening?.results?.[0] as { total: number } | undefined)?.total ?? 0) as number,
              daily: (daily?.results ?? []) as Array<{ date: string; total: number }>,
              future: (future?.results ?? []) as Array<{ date: string; amount: number; categoryId: string | null; name: string }>,
            }
          }),
          schedules.occurrences(today > start ? today : start, end),
        ])

        const single = raw.accounts[0]
        if (accountId !== null && !single) return yield* new NotFound({ entity: "Compte", id: accountId })
        // One account carries the part of the budget it has been paying lately: most of it for the
        // checking account, nothing for a savings account. Without history, its kind decides.
        const history =
          accountId === null
            ? 1
            : raw.share.total > 0
              ? Math.max(0, raw.share.mine) / raw.share.total
              : single?.offBudget === 0 && (single.kind === "checking" || single.kind === "credit")
                ? 1
                : 0
        const withBudget = scope.withBudget ?? history > 0
        // Asked to count the budget on an account that never paid any of it: all of it, then.
        const budgetShare = withBudget && history === 0 ? 1 : history

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
          ...scheduledItems(occurrences, new Set(raw.accounts.map((a) => a.id))),
        ]
        const forecast = computeForecast({
          today,
          month: m,
          categories,
          dailyBalances,
          openingBalance: raw.opening,
          upcoming,
          withBudget,
          budgetShare,
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
              d1.prepare(`SELECT a.id FROM accounts a WHERE ${SCOPE}`).bind(accountId),
              d1.prepare(
                `SELECT t.date, t.amount, t.category_id AS categoryId, COALESCE(pa.name, p.name, 'Opération') AS name
                 FROM transactions t JOIN accounts a ON a.id = t.account_id
                 LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
                 WHERE ${SCOPE} AND t.parent_id IS NULL AND t.date > ?2 AND t.date <= ?3`,
              ).bind(accountId, today, until),
            ])
            return {
              accounts: (accounts?.results ?? []) as Array<{ id: string }>,
              future: (future?.results ?? []) as Array<{ date: string; amount: number; categoryId: string | null; name: string }>,
            }
          }),
          schedules.occurrences(today, until),
        ])
        const items: UpcomingItem[] = [
          ...raw.future.map((t) => ({ ...t, source: "transaction" as const, scheduleId: null })),
          ...scheduledItems(occurrences, new Set(raw.accounts.map((a) => a.id))),
        ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        return { today, until, items } satisfies UpcomingDto
      })

      return ForecastService.of({ month, upcoming })
    }),
  )
}

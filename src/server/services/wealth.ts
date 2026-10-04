import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Result } from "effect"
import { addMonths, type Day, diffDays, isDay, lastDay, type Month, monthOf, monthRange } from "~/domain/dates"
import {
  type AllocationSlice,
  allocation,
  applyShare,
  type AssetType,
  type AssetValues,
  BUCKET_OF_TYPE,
  type DatedAmount,
  FULL_SHARE,
  isShare,
  latestOn,
  loanBalance,
  type RetainedKind,
  historyChange,
  retainedValueAt,
  type WealthBucket,
  type WealthChange,
} from "~/domain/wealth"
import { bulkInsertStatements, Db, type DbError, newId } from "../db/client"
import { readSource } from "../db/json-columns"
import { assets, assetValuations, type ValuationSource } from "../db/schema"
import { type ExternalError, Invalid, NotFound } from "../errors"
import { MarketData } from "./market-data"
import { Settings } from "./settings"

type EstimateDto = {
  amount: number
  date: Day
  /** Where the number comes from, shown under it ("Estimation DVF", "Cours en direct"…). */
  label: string
  automatic: boolean
  unitPrice: number | null
  /** Last month of data behind the estimate, when the source lags (DVF). */
  asOf: Month | null
}

export type WealthItem = {
  id: string
  kind: "asset" | "account"
  name: string
  type: AssetType
  bucket: WealthBucket
  subtitle: string | null
  isLiability: boolean
  purchase: DatedAmount | null
  declared: DatedAmount | null
  estimate: EstimateDto | null
  retained: RetainedKind
  /** The value actually used, after falling back when the retained one is missing. */
  retainedUsed: RetainedKind | null
  /**
   * Part owned, in basis points. `purchase`, `declared` and `estimate` are for the whole asset;
   * `value` and `history` are already reduced to this part.
   */
  share: number
  /** Signed contribution to the net worth (liabilities are negative). */
  value: number
  /** Retained value at each month end of `WealthOverview.months` (signed). */
  history: number[]
  /** A manual estimate older than six months, worth refreshing by hand. */
  stale: boolean
  source: ValuationSource | null
  notes: string | null
}

export type WealthOverview = {
  today: Day
  months: Month[]
  netWorth: number
  /**
   * Change over the history window, measured from its first non-zero month: with less than a
   * year of data, "since March" is honest where "over 12 months" would compare against nothing.
   */
  change: WealthChange | null
  allocation: AllocationSlice[]
  history: number[]
  items: WealthItem[]
  /** Closed accounts, left out of `items` but still counted in the months they held money. */
  closed: Array<{ type: AssetType; history: number[] }>
  /** Some automatic estimates are out of date: the page refreshes them in the background. */
  needsRefresh: boolean
}

export type AssetInput = {
  name: string
  type: AssetType
  subtitle: string | null
  purchase: DatedAmount | null
  declared: DatedAmount | null
  retained: RetainedKind
  share: number
  source: ValuationSource
  notes: string | null
}

export type RefreshResult = { updated: number; failures: Array<{ assetId: string; name: string; message: string }> }


type AssetRow = typeof assets.$inferSelect
type ValuationRow = {
  assetId: string
  date: Day
  amount: number
  source: string
  automatic: number
  unitPrice: number | null
  asOf: Month | null
}

const HISTORY_MONTHS = 12
// CoinGecko's public API answers 429 beyond a few calls a minute: the yearly histories of new
// coins are fetched one at a time, a few per refresh, and the next refreshes fetch the rest.
const COIN_HISTORIES_PER_REFRESH = 3
const STALE_MANUAL_DAYS = 183
const DVF_REFRESH_DAYS = 30

const SOURCE_LABELS: Record<string, string> = {
  dvf: "Estimation DVF",
  coingecko: "Cours en direct",
  yahoo: "Cours en direct",
  manual: "Saisie manuelle",
}

const isAutomatic = (source: ValuationSource) => source.kind === "crypto" || source.kind === "stock" || source.kind === "real_estate"

const refreshDue = (source: ValuationSource, lastAutomatic: Day | null, today: Day) =>
  isAutomatic(source) &&
  (lastAutomatic === null || (source.kind === "real_estate" ? diffDays(lastAutomatic, today) >= DVF_REFRESH_DAYS : lastAutomatic < today))

/**
 * Past month-ends are still to be priced while no automatic value predates this month, unless the
 * asset was bought this month. A history that failed or was postponed is retried next refresh.
 */
const lacksHistory = (asset: { purchaseDate: string | null }, firstAutomatic: Day | null, today: Day) => {
  const monthStart = `${monthOf(today)}-01`
  return (firstAutomatic === null || firstAutomatic >= monthStart) && (asset.purchaseDate === null || asset.purchaseDate < monthStart)
}

/** Why an asset's valuation source cannot be used, or null. Also guards restored backups. */
export const sourceProblem = (type: string, s: ValuationSource): string | null => {
  const positive = (n: number) => Number.isFinite(n) && n > 0
  if (type === "loan" && s.kind !== "loan") return "Un emprunt se décrit par son capital, son taux et sa durée."
  if (s.kind === "loan") {
    if (type !== "loan") return "Le tableau d'amortissement est réservé aux emprunts."
    if (!positive(s.principal) || !positive(s.months) || !(Number.isFinite(s.annualRatePct) && s.annualRatePct >= 0) || !isDay(s.startDate)) {
      return "Renseigne le capital, le taux, la durée et la date de début de l'emprunt."
    }
  }
  if ((s.kind === "crypto" || s.kind === "stock") && !positive(s.quantity)) return "La quantité doit être positive."
  if (s.kind === "crypto" && s.coinId.trim() === "") return "Choisis une crypto-monnaie."
  if (s.kind === "stock" && s.symbol.trim() === "") return "Choisis un titre coté."
  if (s.kind === "real_estate" && (!/^\w{5}$/.test(s.inseeCode) || !positive(s.surface))) return "Choisis une commune et indique la surface."
  return null
}

export class Wealth extends Context.Service<
  Wealth,
  {
    readonly overview: Effect.Effect<WealthOverview, DbError>
    /** The overview without the accounts, which are read from every operation of their history. */
    readonly assetsOverview: Effect.Effect<WealthOverview, DbError>
    create(input: AssetInput): Effect.Effect<string, DbError | Invalid>
    update(id: string, input: AssetInput): Effect.Effect<void, DbError | Invalid | NotFound>
    remove(id: string): Effect.Effect<void, DbError>
    addValuation(input: { assetId: string; date: Day; amount: number }): Effect.Effect<void, DbError | Invalid | NotFound>
    /**
     * Fetches automatic estimates (crypto, quotes, DVF) for the assets that are due, or for `ids`
     * regardless of age. One request per source, not per asset, where the source allows it.
     */
    refresh(options?: { ids?: ReadonlyArray<string> }): Effect.Effect<RefreshResult, DbError>
  }
>()("runway/server/services/Wealth") {
  static readonly layer = Layer.effect(
    Wealth,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings
      const market = yield* MarketData

      const loadAssets = db
        .use((orm) => orm.select().from(assets).where(eq(assets.archived, false)))
        .pipe(Effect.map((rows) => rows.map((a) => ({ ...a, source: readSource(a.source) }))))

      // Everything in the history window, plus the last value before it (the starting point).
      const loadValuations = (since: Day) =>
        db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `SELECT v.asset_id AS assetId, v.date, v.amount, v.source, v.automatic, v.unit_price AS unitPrice, v.as_of AS asOf
               FROM asset_valuations v
               WHERE v.date >= ?1
                  OR v.date = (SELECT MAX(v2.date) FROM asset_valuations v2 WHERE v2.asset_id = v.asset_id AND v2.date < ?1)
               ORDER BY v.asset_id, v.date, v.automatic DESC`,
            )
            .bind(since)
            .all<ValuationRow>()
          return results
        })

      const lastAutomaticDates = db
        .use((_, d1) =>
          d1
            .prepare("SELECT asset_id AS assetId, MAX(date) AS date FROM asset_valuations WHERE automatic = 1 GROUP BY asset_id")
            .all<{ assetId: string; date: Day }>(),
        )
        .pipe(Effect.map(({ results }) => new Map(results.map((r) => [r.assetId, r.date]))))

      const automaticSpans = db
        .use((_, d1) =>
          d1
            .prepare("SELECT asset_id AS assetId, MIN(date) AS first, MAX(date) AS last FROM asset_valuations WHERE automatic = 1 GROUP BY asset_id")
            .all<{ assetId: string; first: Day; last: Day }>(),
        )
        .pipe(Effect.map(({ results }) => new Map(results.map((r) => [r.assetId, r]))))

      // Balances stop at today like the accounts pages; the monthly sums only cover the window.
      const accountRows = (since: Day, today: Day) =>
        db.use(async (_, d1) => {
          const [accounts, monthly] = await d1.batch([
            d1
              .prepare(
                `SELECT a.id, a.name, a.kind, a.off_budget AS offBudget, a.closed,
                   COALESCE(SUM(CASE WHEN t.date <= ?2 THEN t.amount END), 0) AS balance,
                   COALESCE(SUM(CASE WHEN t.date < ?1 THEN t.amount END), 0) AS opening
                 FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id AND t.parent_id IS NULL
                 GROUP BY a.id ORDER BY a.off_budget, a.sort_order, a.name COLLATE NOCASE`,
              )
              .bind(since, today),
            d1
              .prepare(
                `SELECT t.account_id AS accountId, substr(t.date, 1, 7) AS month, SUM(t.amount) AS total
                 FROM transactions t
                 WHERE t.parent_id IS NULL AND t.date >= ?1 AND t.date <= ?2 GROUP BY 1, 2 ORDER BY 1, 2`,
              )
              .bind(since, today),
          ])
          return {
            accounts: (accounts?.results ?? []) as Array<{
              id: string
              name: string
              kind: string
              offBudget: number
              closed: number
              balance: number
              opening: number
            }>,
            monthly: (monthly?.results ?? []) as Array<{ accountId: string; month: Month; total: number }>,
          }
        })

      const overviewOf = (withAccounts: boolean) => Effect.gen(function* () {
        const today = yield* settings.today
        const current = monthOf(today)
        const months = monthRange(addMonths(current, -HISTORY_MONTHS), current)
        // Past months are read at their last day, the current one today.
        const days = months.map((m) => (m === current ? today : lastDay(m)))
        const [rows, valuations, lastAuto, accountData] = yield* Effect.all(
          [
            loadAssets,
            loadValuations(days[0]!),
            lastAutomaticDates,
            withAccounts ? accountRows(`${months[0]!}-01`, today) : Effect.succeed({ accounts: [], monthly: [] }),
          ],
          { concurrency: "unbounded" },
        )

        const byAsset = new Map<string, ValuationRow[]>()
        for (const v of valuations) {
          const own = byAsset.get(v.assetId)
          if (own) own.push(v)
          else byAsset.set(v.assetId, [v])
        }

        const items: WealthItem[] = rows.map((a) => {
          const own = byAsset.get(a.id) ?? []
          const source = a.source
          const estimateAt =
            source.kind === "loan"
              ? (day: Day): DatedAmount | null => (day < source.startDate ? null : { amount: loanBalance(source, day), date: day })
              : (day: Day) => latestOn(own, day)
          const values: AssetValues = {
            purchase: a.purchaseAmount === null ? null : { amount: a.purchaseAmount, date: a.purchaseDate },
            declared: a.declaredAmount === null ? null : { amount: a.declaredAmount, date: a.declaredDate },
            estimateAt,
            retained: a.retained,
          }
          const sign = a.isLiability ? -1 : 1
          const owned = (amount: number | undefined) => sign * applyShare(amount ?? 0, a.share)
          const now = retainedValueAt(values, today)
          const latest = source.kind === "loan" ? null : own.at(-1)
          const estimate: EstimateDto | null =
            source.kind === "loan"
              ? { amount: loanBalance(source, today), date: today, label: "Tableau d'amortissement", automatic: true, unitPrice: null, asOf: null }
              : latest
                ? {
                    amount: latest.amount,
                    date: latest.date,
                    label: SOURCE_LABELS[latest.source] ?? latest.source,
                    automatic: latest.automatic === 1,
                    unitPrice: latest.unitPrice,
                    asOf: latest.asOf,
                  }
                : null
          return {
            id: a.id,
            kind: "asset",
            name: a.name,
            type: a.type,
            bucket: BUCKET_OF_TYPE[a.type],
            subtitle: a.subtitle,
            isLiability: a.isLiability,
            purchase: values.purchase,
            declared: values.declared,
            estimate,
            retained: a.retained,
            retainedUsed: now?.kind ?? null,
            share: a.share,
            value: owned(now?.amount),
            history: days.map((d) => owned(retainedValueAt(values, d)?.amount)),
            stale: !isAutomatic(source) && source.kind !== "loan" && estimate !== null && diffDays(estimate.date, today) > STALE_MANUAL_DAYS,
            source,
            notes: a.notes,
          }
        })

        const monthlyByAccount = new Map<string, Array<{ month: Month; total: number }>>()
        for (const r of accountData.monthly) {
          const own = monthlyByAccount.get(r.accountId)
          if (own) own.push(r)
          else monthlyByAccount.set(r.accountId, [r])
        }
        // A closed account leaves the list but still counts in the months it held money.
        const closed: WealthOverview["closed"] = []
        for (const account of accountData.accounts) {
          let running = account.opening
          let i = 0
          const sums = monthlyByAccount.get(account.id) ?? []
          const history = months.map((m) => {
            if (m === current) return account.balance
            while (i < sums.length && sums[i]!.month <= m) running += sums[i++]!.total
            return running
          })
          const type: AssetType = account.kind === "investment" ? "investment" : "cash"
          if (account.closed) {
            closed.push({ type, history })
            continue
          }
          items.push({
            id: account.id,
            kind: "account",
            name: account.name,
            type,
            bucket: BUCKET_OF_TYPE[type],
            subtitle: account.offBudget ? "Compte hors budget" : "Compte du budget",
            isLiability: false,
            purchase: null,
            declared: null,
            estimate: { amount: account.balance, date: today, label: "Compte suivi", automatic: true, unitPrice: null, asOf: null },
            retained: "estimated",
            retainedUsed: "estimated",
            share: FULL_SHARE,
            value: account.balance,
            history,
            stale: false,
            source: null,
            notes: null,
          })
        }

        const history = months.map(
          (_, i) => items.reduce((sum, item) => sum + item.history[i]!, 0) + closed.reduce((sum, c) => sum + c.history[i]!, 0),
        )
        const netWorth = items.reduce((sum, item) => sum + item.value, 0)
        const change = historyChange(history, months, netWorth)
        return {
          today,
          months,
          netWorth,
          change,
          allocation: allocation(items),
          history,
          items,
          closed,
          needsRefresh: rows.some((a) => refreshDue(a.source, lastAuto.get(a.id) ?? null, today)),
        } satisfies WealthOverview
      })
      const overview = overviewOf(true).pipe(Effect.withSpan("Wealth.overview"))
      const assetsOverview = overviewOf(false).pipe(Effect.withSpan("Wealth.assetsOverview"))

      const validate = (input: AssetInput): Effect.Effect<AssetInput, Invalid> => {
        const fail = (message: string) => Effect.fail(new Invalid({ message }))
        const name = input.name.trim()
        if (name === "") return fail("Le nom est obligatoire.")
        for (const v of [input.purchase, input.declared]) {
          if (v && (!Number.isInteger(v.amount) || v.amount < 0)) return fail("Les montants doivent être positifs.")
          if (v && v.date !== null && !isDay(v.date)) return fail("Date invalide.")
        }
        if (!isShare(input.share)) return fail("La part détenue doit être comprise entre 0 et 100 %.")
        const problem = sourceProblem(input.type, input.source)
        if (problem) return fail(problem)
        return Effect.succeed({ ...input, name, subtitle: input.subtitle?.trim() || null, notes: input.notes?.trim() || null })
      }

      const columns = (input: AssetInput) => ({
        name: input.name,
        type: input.type,
        isLiability: input.type === "loan",
        subtitle: input.subtitle,
        purchaseAmount: input.purchase?.amount ?? null,
        purchaseDate: input.purchase?.date ?? null,
        declaredAmount: input.declared?.amount ?? null,
        declaredDate: input.declared?.date ?? null,
        retained: input.retained,
        share: input.share,
        source: input.source,
        notes: input.notes,
      })

      /**
       * The first time an asset gets a market price, its past 12 month-ends are priced too, so that
       * the net worth trend means something from day one instead of jumping on the creation day.
       * Best effort: a source without history just leaves the past empty.
       */
      const backfillHistory = Effect.fn("Wealth.backfillHistory")(function* (fresh: ReadonlyArray<AssetRow>, today: Day) {
        const rows: Array<{ assetId: string; date: Day; amount: number; source: string; unitPrice: number }> = []
        if (fresh.length === 0) return rows
        const current = monthOf(today)
        const monthEnds = monthRange(addMonths(current, -HISTORY_MONTHS), addMonths(current, -1)).map(lastDay)
        const keyOf = (s: ValuationSource) =>
          s.kind === "crypto" ? `crypto|${s.coinId}` : s.kind === "stock" ? `stock|${s.symbol}` : s.kind === "real_estate" ? `dvf|${s.inseeCode}|${s.propertyType}` : null
        const keys = [...new Set(fresh.flatMap((a) => keyOf(a.source) ?? []))]
        const histories = new Map(
          yield* Effect.forEach(
            keys.filter((key) => !key.startsWith("crypto|")),
            (key) => {
              const [kind, id, type] = key.split("|") as [string, string, "apartment" | "house"]
              const fetch = kind === "stock" ? market.quoteHistory(id) : market.dvfHistory(id, type)
              return fetch.pipe(
                Effect.option,
                Effect.map((o) => [key, o._tag === "Some" ? o.value : []] as const),
              )
            },
            { concurrency: 4 },
          ),
        )
        for (const key of keys.filter((k) => k.startsWith("crypto|")).slice(0, COIN_HISTORIES_PER_REFRESH)) {
          const history = yield* market.cryptoHistory(key.slice("crypto|".length)).pipe(Effect.result)
          if (history._tag === "Success") histories.set(key, history.success)
          else if (history.failure.rateLimited) break
        }
        for (const asset of fresh) {
          const s = asset.source
          const key = keyOf(s)
          if (!key || s.kind === "manual" || s.kind === "loan") continue
          const points = histories.get(key)
          if (!points) continue
          const factor = s.kind === "real_estate" ? s.surface : s.quantity
          const source = s.kind === "crypto" ? "coingecko" : s.kind === "stock" ? "yahoo" : "dvf"
          for (const day of monthEnds) {
            if (asset.purchaseDate && day < asset.purchaseDate) continue
            const point = latestOn(points, day)
            if (point) rows.push({ assetId: asset.id, date: day, amount: Math.round(point.price * factor * 100), source, unitPrice: point.price })
          }
        }
        return rows
      })

      const refresh = Effect.fn("Wealth.refresh")(function* (options: { ids?: ReadonlyArray<string> } = {}) {
        const today = yield* settings.today
        const [rows, spans] = yield* Effect.all([loadAssets, automaticSpans], { concurrency: "unbounded" })
        const wanted = options.ids ? new Set(options.ids) : null
        const due = rows.filter((a) =>
          wanted ? wanted.has(a.id) && isAutomatic(a.source) : refreshDue(a.source, spans.get(a.id)?.last ?? null, today),
        )
        const failures: RefreshResult["failures"] = []
        const estimates: Array<{ assetId: string; amount: number; source: string; unitPrice: number; asOf?: Month }> = []
        const fail = (a: AssetRow, message: string) => failures.push({ assetId: a.id, name: a.name, message })
        const errorMessage = (e: ExternalError) => e.message

        const crypto = due.flatMap((a) => (a.source.kind === "crypto" ? [{ asset: a, source: a.source }] : []))
        const stocks = due.flatMap((a) => (a.source.kind === "stock" ? [{ asset: a, source: a.source }] : []))
        const homes = due.flatMap((a) => (a.source.kind === "real_estate" ? [{ asset: a, source: a.source }] : []))
        const dvfKeys = [...new Set(homes.map((h) => `${h.source.inseeCode}|${h.source.propertyType}`))]
        const none = Effect.succeed(Result.succeed(new Map<string, number>()))
        // The three sources are independent: their timeouts add up when called one after another.
        // Together they stay within the 6 connections a Worker may open at once (1 + 3 + 2).
        const [cryptoPrices, stockPrices, dvfEntries] = yield* Effect.all(
          [
            crypto.length ? market.cryptoPrices([...new Set(crypto.map((c) => c.source.coinId))]).pipe(Effect.result) : none,
            market.quotes([...new Set(stocks.map((s) => s.source.symbol))]),
            Effect.forEach(
              dvfKeys,
              (key) => {
                const [insee, type] = key.split("|") as [string, "apartment" | "house"]
                return market.dvfPricePerM2(insee, type).pipe(Effect.result, Effect.map((r) => [key, r] as const))
              },
              { concurrency: 2 },
            ),
          ],
          { concurrency: "unbounded" },
        )

        for (const { asset, source } of crypto) {
          const price = cryptoPrices._tag === "Success" ? cryptoPrices.success.get(source.coinId) : undefined
          if (price === undefined) fail(asset, cryptoPrices._tag === "Failure" ? errorMessage(cryptoPrices.failure) : "Cours indisponible.")
          else estimates.push({ assetId: asset.id, amount: Math.round(price * source.quantity * 100), source: "coingecko", unitPrice: price })
        }
        for (const { asset, source } of stocks) {
          const price = stockPrices.get(source.symbol)
          if (price === undefined || price._tag === "Failure") {
            fail(asset, price ? errorMessage(price.failure) : `Cours introuvable pour ${source.symbol}.`)
          } else {
            const unitPrice = price.success
            estimates.push({ assetId: asset.id, amount: Math.round(unitPrice * source.quantity * 100), source: "yahoo", unitPrice })
          }
        }
        const dvf = new Map(dvfEntries)
        for (const { asset, source } of homes) {
          const result = dvf.get(`${source.inseeCode}|${source.propertyType}`)!
          if (result._tag === "Failure") fail(asset, errorMessage(result.failure))
          else {
            const { pricePerM2: price, to } = result.success
            estimates.push({ assetId: asset.id, amount: Math.round(price * source.surface * 100), source: "dvf", unitPrice: price, asOf: to })
          }
        }

        const backfill = yield* backfillHistory(
          due.filter((a) => lacksHistory(a, spans.get(a.id)?.first ?? null, today) && estimates.some((e) => e.assetId === a.id)),
          today,
        )

        // One automatic estimate per asset and day: a second refresh the same day replaces it.
        yield* db.batch(
          estimates.flatMap((e) => [
            db.d1.prepare("DELETE FROM asset_valuations WHERE asset_id = ? AND date = ? AND automatic = 1").bind(e.assetId, today),
            db.d1
              .prepare(
                "INSERT INTO asset_valuations (id, asset_id, date, amount, source, unit_price, as_of, automatic) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
              )
              .bind(newId(), e.assetId, today, e.amount, e.source, e.unitPrice, e.asOf ?? null),
          ]),
        )
        yield* db.batch(
          bulkInsertStatements(
            db.d1,
            "asset_valuations",
            ["id", "asset_id", "date", "amount", "source", "unit_price", "automatic"],
            backfill.map((b) => [newId(), b.assetId, b.date, b.amount, b.source, b.unitPrice, 1]),
          ),
        )
        return { updated: estimates.length, failures }
      })

      const create = Effect.fn("Wealth.create")(function* (raw: AssetInput) {
        const input = yield* validate(raw)
        const id = newId()
        yield* db.use((orm) => orm.insert(assets).values({ id, ...columns(input) }))
        // Best effort: once the asset is inserted, nothing may fail the creation, or a retry would
        // add it a second time. The wealth page fetches the missing estimate on its next refresh.
        if (isAutomatic(input.source)) {
          yield* refresh({ ids: [id] }).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Première estimation impossible", { id, cause })),
          )
        }
        return id
      })

      const update = Effect.fn("Wealth.update")(function* (id: string, raw: AssetInput) {
        const input = yield* validate(raw)
        const [before] = yield* db.use((orm) => orm.select({ source: assets.source }).from(assets).where(eq(assets.id, id)))
        if (!before) return yield* new NotFound({ entity: "Bien", id })
        yield* db.use((orm) => orm.update(assets).set(columns(input)).where(eq(assets.id, id)))
        if (isAutomatic(input.source) && JSON.stringify(before.source) !== JSON.stringify(input.source)) {
          yield* refresh({ ids: [id] })
        }
      })

      const remove = (id: string) => db.use((orm) => orm.delete(assets).where(eq(assets.id, id))).pipe(Effect.asVoid)

      const addValuation = Effect.fn("Wealth.addValuation")(function* (input: { assetId: string; date: Day; amount: number }) {
        if (!isDay(input.date) || !Number.isInteger(input.amount) || input.amount < 0) {
          return yield* new Invalid({ message: "Indique une date et un montant positif." })
        }
        const today = yield* settings.today
        if (input.date > today) return yield* new Invalid({ message: "Une estimation ne peut pas être datée dans le futur." })
        const [asset] = yield* db.use((orm) => orm.select({ id: assets.id }).from(assets).where(eq(assets.id, input.assetId)))
        if (!asset) return yield* new NotFound({ entity: "Bien", id: input.assetId })
        yield* db.use((orm) =>
          orm.insert(assetValuations).values({
            id: newId(),
            assetId: input.assetId,
            date: input.date,
            amount: input.amount,
            source: "manual",
            automatic: false,
          }),
        )
      })

      return Wealth.of({
        overview,
        assetsOverview,
        create,
        update,
        remove,
        addValuation,
        refresh,
      })
    }),
  )
}

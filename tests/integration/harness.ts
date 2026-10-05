import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Cause, Clock, Effect, Exit, Layer, ManagedRuntime, Option, Result, Schema } from "effect"
import { Miniflare } from "miniflare"
import type { BundleExtras, BundleStructure, IdMaps } from "~/lib/import-bundle"
import type { ImportApi } from "~/lib/import-client"
import { makeCoreLayer } from "~/server/app-layer"
import { ExternalError } from "~/server/errors"
import { ImportExtrasInput, ImportStructureInput, ImportTransactionsInput } from "~/server/fns/data"
import type { AiProviders } from "~/server/services/ai"
import { ImportExport } from "~/server/services/import-export"
import { MarketData } from "~/server/services/market-data"

type Services = Layer.Success<ReturnType<typeof makeCoreLayer>>

/** Applies the drizzle migrations to a D1 database, statement by statement. */
const migrate = async (d1: D1Database) => {
  const dir = join(process.cwd(), "drizzle")
  for (const migration of readdirSync(dir).sort()) {
    const statements = readFileSync(join(dir, migration, "migration.sql"), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)
    await d1.batch(statements.map((s) => d1.prepare(s)))
  }
}

const USER_TABLES = [
  "accounts",
  "category_groups",
  "categories",
  "payees",
  "transactions",
  "budgets",
  "budget_months",
  "rules",
  "schedules",
  "assets",
  "asset_valuations",
  "saved_views",
  "dashboards",
] as const

/** Row count of every table that holds user data, to check that an import adds nothing twice. */
export const tableCounts = async (d1: D1Database): Promise<Record<(typeof USER_TABLES)[number], number>> => {
  const results = await d1.batch<{ n: number }>(USER_TABLES.map((t) => d1.prepare(`SELECT COUNT(*) AS n FROM ${t}`)))
  return Object.fromEntries(USER_TABLES.map((t, i) => [t, results[i]?.results[0]?.n ?? 0])) as Record<(typeof USER_TABLES)[number], number>
}

// Shared CI runners are several times slower than a developer machine: wall-clock bounds (and
// the timeouts around them) are scaled by PERF_FACTOR, 3 by default on CI.
const perfFactor = Number(process.env.PERF_FACTOR) || (process.env.CI ? 3 : 1)

/** A wall-clock bound (or test timeout) in ms, scaled for slower machines. */
export const timeBudget = (ms: number) => ms * perfFactor

export type Harness = Awaited<ReturnType<typeof createHarness>>

/**
 * A fresh local D1 (workerd, the same engine as production) per test file, with
 * migrations applied and the application layer ready to run effects against it.
 */
/** Tests never reach the network: every market source is down unless a test provides one. */
const offlineMarket: MarketData["Service"] = (() => {
  const down = Effect.fail(new ExternalError({ service: "test", message: "Hors ligne" }))
  return MarketData.of({
    cryptoPrices: () => down,
    quotes: (symbols) => Effect.succeed(new Map(symbols.map((s) => [s, Result.fail(new ExternalError({ service: "test", message: "Hors ligne" }))]))),
    dvfPricePerM2: () => down,
    cryptoHistory: () => down,
    quoteHistory: () => down,
    dvfHistory: () => down,
    searchCoins: () => down,
    searchSymbols: () => down,
    searchCommunes: () => down,
  })
})()

/**
 * A clock that reads `now` (an ISO instant) and then moves 1 ms per read, so that creation stamps
 * stay ordered while "today" stays put. `set` moves it to another instant.
 */
const frozenClock = (now: string) => {
  const live = Clock.Clock.defaultValue()
  const parse = (instant: string) => {
    const millis = Date.parse(instant)
    if (Number.isNaN(millis)) throw new Error(`Invalid instant: ${instant}`)
    return millis
  }
  let millis = parse(now)
  const read = () => millis++
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: read,
    currentTimeMillis: Effect.sync(read),
    currentTimeNanosUnsafe: () => BigInt(read()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(read()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  }
  return {
    clock,
    set: (instant: string) => {
      millis = parse(instant)
    },
  }
}

export const createHarness = async (
  options: {
    ai?: AiProviders
    market?: Partial<MarketData["Service"]>
    /** Freezes the services' clock on this instant (ISO, e.g. "2026-10-04T10:00:00Z"); the wall clock otherwise. */
    now?: string
  } = {},
) => {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "runway-tests",
          compatibilityDate: "2026-09-30",
          manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {}" } } },
          env: { DB: { type: "d1" } },
        },
      },
    ],
  })
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database
  await migrate(d1)
  // Workers cap the queries of one invocation (50 on the free plan), each statement of a batch
  // included: every statement the application prepares is counted.
  let statements = 0
  const counted = new Proxy(d1, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) => {
          statements++
          return target.prepare(query)
        }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const frozen = options.now ? frozenClock(options.now) : null
  const core = makeCoreLayer(counted, options.ai, Layer.succeed(MarketData, MarketData.of({ ...offlineMarket, ...options.market })))
  const runtime = ManagedRuntime.make(frozen ? Layer.merge(core, Layer.succeed(Clock.Clock, frozen.clock)) : core)
  return {
    d1,
    run: <A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> => runtime.runPromise(effect),
    /** How many D1 statements `effect` runs. */
    statementsOf: async <A, E>(effect: Effect.Effect<A, E, Services>): Promise<{ value: A; statements: number }> => {
      const before = statements
      const value = await runtime.runPromise(effect)
      return { value, statements: statements - before }
    },
    /** The typed failure of an effect expected to fail, to assert on its `_tag`. */
    fail: async <A, E>(effect: Effect.Effect<A, E, Services>): Promise<E> => {
      const exit = await runtime.runPromiseExit(effect)
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      if (Option.isNone(error)) throw new Error(`Expected a failure, got ${Exit.isSuccess(exit) ? "a success" : Cause.pretty(exit.cause)}`)
      return error.value
    },
    /** Moves the frozen clock (see `now`) to another instant. */
    setNow: (instant: string) => {
      if (!frozen) throw new Error("setNow needs a harness created with `now`")
      frozen.set(instant)
    },
    dispose: async () => {
      await runtime.dispose()
      await mf.dispose()
    },
  }
}


// What a server function receives: its input sent as JSON, then decoded by its validator, which
// drops any field it does not declare.
const overTheWire = (input: unknown): unknown => JSON.parse(JSON.stringify(input))

/** The import calls the browser makes, through the same validators as the server functions. */
export const importApi = (h: Harness): ImportApi & { importExtras: (input: { extras: BundleExtras; maps: IdMaps }) => Promise<{ assets: number; views: number }> } => ({
  importStructure: (input) => {
    const data = Schema.decodeUnknownSync(ImportStructureInput)(overTheWire(input))
    return h.run(ImportExport.use((s) => s.importStructure(data.structure as unknown as BundleStructure, data.include)))
  },
  importTransactions: (input) => {
    const data = Schema.decodeUnknownSync(ImportTransactionsInput)(overTheWire(input))
    return h.run(ImportExport.use((s) => s.importTransactions(data.rows, data.options)))
  },
  importExtras: (input) => {
    const data = Schema.decodeUnknownSync(ImportExtrasInput)(overTheWire(input))
    return h.run(ImportExport.use((s) => s.importExtras(data.extras as unknown as BundleExtras, data.maps)))
  },
})

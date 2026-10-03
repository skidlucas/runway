import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Result } from "effect"
import { Miniflare } from "miniflare"
import { makeCoreLayer } from "~/server/app-layer"
import { ExternalError } from "~/server/errors"
import type { AiProviders } from "~/server/services/ai"
import { MarketData } from "~/server/services/market-data"

type Services = Layer.Success<ReturnType<typeof makeCoreLayer>>

/** Applies the drizzle migrations to a D1 database, statement by statement. */
export const migrate = async (d1: D1Database) => {
  const dir = join(process.cwd(), "drizzle")
  for (const migration of readdirSync(dir).sort()) {
    const statements = readFileSync(join(dir, migration, "migration.sql"), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)
    await d1.batch(statements.map((s) => d1.prepare(s)))
  }
}

export type Harness = Awaited<ReturnType<typeof createHarness>>

/**
 * A fresh local D1 (workerd, the same engine as production) per test file, with
 * migrations applied and the application layer ready to run effects against it.
 */
/** Tests never reach the network: every market source is down unless a test provides one. */
export const offlineMarket: MarketData["Service"] = (() => {
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

export const createHarness = async (options: { ai?: AiProviders; market?: Partial<MarketData["Service"]> } = {}) => {
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
  const runtime = ManagedRuntime.make(
    makeCoreLayer(d1, options.ai, Layer.succeed(MarketData, MarketData.of({ ...offlineMarket, ...options.market }))),
  )
  return {
    d1,
    run: <A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> => runtime.runPromise(effect),
    /** The typed failure of an effect expected to fail, to assert on its `_tag`. */
    fail: async <A, E>(effect: Effect.Effect<A, E, Services>): Promise<E> => {
      const exit = await runtime.runPromiseExit(effect)
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      if (Option.isNone(error)) throw new Error(`Expected a failure, got ${Exit.isSuccess(exit) ? "a success" : Cause.pretty(exit.cause)}`)
      return error.value
    },
    dispose: async () => {
      await runtime.dispose()
      await mf.dispose()
    },
  }
}


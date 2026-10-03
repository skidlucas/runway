import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { getPlatformProxy } from "wrangler"
import { makeCoreLayer } from "~/server/app-layer"
import { ExternalError } from "~/server/errors"
import type { AiProviders } from "~/server/services/ai"
import { MarketData } from "~/server/services/market-data"

type Services = Layer.Success<ReturnType<typeof makeCoreLayer>>

/** Applies the drizzle migrations to a D1 database, statement by statement. */
export const migrate = async (d1: D1Database) => {
  const dir = join(process.cwd(), "drizzle")
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const statements = readFileSync(join(dir, file), "utf8")
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
    quotes: () => down,
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
  const dir = mkdtempSync(join(tmpdir(), "runway-it-"))
  const proxy = await getPlatformProxy<Env>({ persist: { path: dir } })
  const d1 = proxy.env.DB
  await migrate(d1)
  const runtime = ManagedRuntime.make(
    makeCoreLayer(d1, options.ai, Layer.succeed(MarketData, MarketData.of({ ...offlineMarket, ...options.market }))),
  )
  return {
    d1,
    run: <A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> => runtime.runPromise(effect),
    dispose: async () => {
      await runtime.dispose()
      await proxy.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}


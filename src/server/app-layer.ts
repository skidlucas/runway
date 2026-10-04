import { Layer } from "effect"
import { Db } from "./db/client"
import { Accounts } from "./services/accounts"
import { Ai, AiConfig, type AiProviders, aiProvidersFromEnv, noAiProviders } from "./services/ai"
import { Budget } from "./services/budget"
import { Categorizer } from "./services/categorize"
import { Categories } from "./services/categories"
import { Dashboards } from "./services/dashboards"
import { Demo } from "./services/demo"
import { ForecastService } from "./services/forecast"
import { ImportExport } from "./services/import-export"
import { Insights } from "./services/insights"
import { LoginGuard } from "./services/login-guard"
import { MarketData } from "./services/market-data"
import { Payees } from "./services/payees"
import { Reports } from "./services/reports"
import { Rules } from "./services/rules"
import { Schedules } from "./services/schedules"
import { SessionEpoch } from "./services/session-epoch"
import { Settings } from "./services/settings"
import { Transactions } from "./services/transactions"
import { Wealth } from "./services/wealth"

/** Every domain service, wired on top of a D1 binding. */
export const makeCoreLayer = (
  d1: D1Database,
  ai: AiProviders = noAiProviders,
  market: Layer.Layer<MarketData> = MarketData.layer,
) => {
  const base = Layer.mergeAll(Settings.layer, Ai.layer, LoginGuard.layer, SessionEpoch.layer, Dashboards.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Db.layer(d1), Layer.succeed(AiConfig, ai), market)),
  )
  const leaves = Layer.mergeAll(Categories.layer, Payees.layer, Rules.layer, Reports.layer).pipe(Layer.provideMerge(base))
  const writes = Transactions.layer.pipe(Layer.provideMerge(leaves))
  const domain = Budget.layer.pipe(Layer.provideMerge(Layer.mergeAll(Accounts.layer, Schedules.layer).pipe(Layer.provideMerge(writes))))
  return Layer.mergeAll(ForecastService.layer, Demo.layer, ImportExport.layer, Insights.layer, Categorizer.layer, Wealth.layer).pipe(
    Layer.provideMerge(domain),
  )
}

export const makeAppLayer = (env: Cloudflare.Env) =>
  makeCoreLayer(env.DB, aiProvidersFromEnv(env as unknown as Record<string, unknown>))

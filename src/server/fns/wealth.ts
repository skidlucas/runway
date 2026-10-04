import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { authMiddleware } from "../auth"
import { runApp } from "../runtime"
import { AssetType, Day, Id, Ids, Name, Notes, RetainedValue, SearchText, ValuationSource } from "../schemas"
import { MarketData } from "../services/market-data"
import { Wealth } from "../services/wealth"

const v = Schema.toStandardSchemaV1

const DatedAmount = Schema.NullOr(Schema.Struct({ amount: Schema.Int, date: Schema.NullOr(Day) }))

const AssetInput = Schema.Struct({
  name: Name,
  type: AssetType,
  subtitle: Schema.NullOr(Name),
  purchase: DatedAmount,
  declared: DatedAmount,
  retained: RetainedValue,
  share: Schema.Int,
  source: ValuationSource,
  notes: Schema.NullOr(Notes),
})

export const getWealth = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Wealth.use((w) => w.overview)))

export const getWealthAssets = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Wealth.use((w) => w.assetsOverview)))

export const createAsset = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(AssetInput))
  .handler(({ data }) => runApp(Wealth.use((w) => w.create(data))))

export const updateAsset = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id, input: AssetInput })))
  .handler(({ data }) => runApp(Wealth.use((w) => w.update(data.id, data.input))))

export const deleteAsset = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id })))
  .handler(({ data }) => runApp(Wealth.use((w) => w.remove(data.id))))

export const addAssetValuation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ assetId: Id, date: Day, amount: Schema.Int })))
  .handler(({ data }) => runApp(Wealth.use((w) => w.addValuation(data))))

export const refreshValuations = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ ids: Schema.optional(Ids) })))
  .handler(({ data }) => runApp(Wealth.use((w) => w.refresh(data.ids ? { ids: data.ids } : {}))))

const Query = v(Schema.Struct({ query: SearchText }))

export const searchCoins = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(Query)
  .handler(({ data }) => runApp(MarketData.use((m) => m.searchCoins(data.query))))

export const searchSymbols = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(Query)
  .handler(({ data }) => runApp(MarketData.use((m) => m.searchSymbols(data.query))))

export const searchCommunes = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(Query)
  .handler(({ data }) => runApp(MarketData.use((m) => m.searchCommunes(data.query))))

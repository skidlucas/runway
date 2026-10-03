import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { authMiddleware } from "../auth"
import { runApp } from "../runtime"
import { Ai } from "../services/ai"
import { Categorizer } from "../services/categorize"
import { Insights } from "../services/insights"

const v = Schema.toStandardSchemaV1

export const InsightQuery = Schema.Struct({
  measure: Schema.Literals(["expenses", "income"]),
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("all") }),
    Schema.Struct({ kind: Schema.Literals(["category", "group", "payee"]), id: Schema.String }),
  ]),
  months: Schema.Int,
  rolling: Schema.Literals([0, 3, 6, 12]),
})

export const getInsightView = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(InsightQuery))
  .handler(({ data }) => runApp(Insights.use((s) => s.view(data))))

export const getFindings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Insights.use((s) => s.findings)))

export const getAiAnalysis = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(() => runApp(Insights.use((s) => s.analysis)))

export const interpretQuestion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ question: Schema.String })))
  .handler(({ data }) => runApp(Insights.use((s) => s.interpret(data.question))))

export const getSavedViews = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Insights.use((s) => s.savedViews)))

export const saveView = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ name: Schema.String, config: InsightQuery })))
  .handler(({ data }) => runApp(Insights.use((s) => s.saveView(data.name, data.config))))

export const deleteView = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Schema.String })))
  .handler(({ data }) => runApp(Insights.use((s) => s.deleteView(data.id))))

export const getAiStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Ai.use((a) => Effect.succeed(a.status))))

export const suggestCategories = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ ids: Schema.optional(Schema.Array(Schema.String)) })))
  .handler(({ data }) => runApp(Categorizer.use((c) => c.suggest(data.ids))))

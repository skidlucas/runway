import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { authMiddleware } from "../auth"
import { runApp } from "../runtime"
import { MonthCount, Name } from "../schemas"
import { Dashboards } from "../services/dashboards"
import { Reports } from "../services/reports"

const v = Schema.toStandardSchemaV1

export const DashboardWidget = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "net_worth",
    "wealth",
    "cash_flow",
    "spending_comparison",
    "category_spending",
    "account_balances",
    "upcoming",
    "insight_view",
  ]),
  size: Schema.Literals([1, 2, 3]),
  months: Schema.optional(Schema.Int),
  days: Schema.optional(Schema.Int),
  viewId: Schema.optional(Schema.String),
})

const Months = Schema.Struct({ months: MonthCount })

export const getNetWorth = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Months))
  .handler(({ data }) => runApp(Reports.use((r) => r.netWorth(data.months))))

export const getCashFlow = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Months))
  .handler(({ data }) => runApp(Reports.use((r) => r.cashFlow(data.months))))

export const getSpendingComparison = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Reports.use((r) => r.spendingComparison)))

export const getCategorySpending = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Months))
  .handler(({ data }) => runApp(Reports.use((r) => r.categorySpending(data.months))))

export const getDashboards = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Dashboards.use((d) => d.list)))

export const createDashboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ name: Name })))
  .handler(({ data }) => runApp(Dashboards.use((d) => d.create(data.name))))

export const saveDashboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(Schema.Struct({ id: Schema.String, name: Schema.optional(Name), widgets: Schema.optional(Schema.Array(DashboardWidget)) })),
  )
  .handler(({ data }) =>
    runApp(
      Dashboards.use((d) =>
        d.save(data.id, {
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.widgets === undefined ? {} : { widgets: data.widgets }),
        }),
      ),
    ),
  )

export const deleteDashboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Schema.String })))
  .handler(({ data }) => runApp(Dashboards.use((d) => d.remove(data.id))))

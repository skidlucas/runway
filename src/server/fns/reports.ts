import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { authMiddleware } from "../auth"
import { runApp } from "../runtime"
import { DashboardWidget, Id, MonthCount, Name } from "../schemas"
import { Dashboards } from "../services/dashboards"
import { Reports } from "../services/reports"

const v = Schema.toStandardSchemaV1

const Months = Schema.Struct({ months: MonthCount })

export const getAccountsTotal = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Months))
  .handler(({ data }) => runApp(Reports.use((r) => r.accountsTotal(data.months))))

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
    v(Schema.Struct({ id: Id, name: Schema.optional(Name), widgets: Schema.optional(Schema.Array(DashboardWidget)) })),
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
  .validator(v(Schema.Struct({ id: Id })))
  .handler(({ data }) => runApp(Dashboards.use((d) => d.remove(data.id))))

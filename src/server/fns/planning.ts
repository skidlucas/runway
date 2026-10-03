import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { authMiddleware } from "../auth"
import { runApp } from "../runtime"
import { ForecastService } from "../services/forecast"
import { Schedules } from "../services/schedules"

const v = Schema.toStandardSchemaV1

const PayeeInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("name"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("id"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("transfer"), accountId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("none") }),
])

const ScheduleInput = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  payee: PayeeInput,
  accountId: Schema.String,
  categoryId: Schema.NullOr(Schema.String),
  amount: Schema.Int,
  recurrence: Schema.Struct({ unit: Schema.Literals(["day", "week", "month", "year"]), interval: Schema.Int }),
  startDate: Schema.String,
  endDate: Schema.optional(Schema.NullOr(Schema.String)),
  autoPost: Schema.Boolean,
})

export const getForecast = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ month: Schema.optional(Schema.String) })))
  .handler(({ data }) => runApp(ForecastService.use((s) => s.month(data.month))))

export const getSchedules = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Schedules.use((s) => s.list)))

export const getScheduleSuggestions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(Schedules.use((s) => s.suggestions)))

export const createSchedule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(ScheduleInput))
  .handler(({ data }) => runApp(Schedules.use((s) => s.create(data))))

export const updateSchedule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Schema.String, input: ScheduleInput, active: Schema.optional(Schema.Boolean) })))
  .handler(({ data }) =>
    runApp(Schedules.use((s) => s.update(data.id, { ...data.input, ...(data.active === undefined ? {} : { active: data.active }) }))),
  )

export const deleteSchedule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Schema.String })))
  .handler(({ data }) => runApp(Schedules.use((s) => s.remove(data.id))))

export const skipSchedule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Schema.String })))
  .handler(({ data }) => runApp(Schedules.use((s) => s.skip(data.id))))

export const postSchedule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Schema.String, date: Schema.optional(Schema.String) })))
  .handler(({ data }) => runApp(Schedules.use((s) => s.post(data.id, data.date))))

export const syncSchedules = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(() => runApp(Schedules.use((s) => s.sync)))

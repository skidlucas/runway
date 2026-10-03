import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { RECURRENCE_UNITS } from "~/domain/recurrence"
import { authMiddleware } from "../auth"
import { runApp } from "../runtime"
import { ForecastService } from "../services/forecast"
import { Schedules } from "../services/schedules"
import { Settings } from "../services/settings"

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
  recurrence: Schema.Struct({ unit: Schema.Literals(RECURRENCE_UNITS), interval: Schema.Int }),
  startDate: Schema.String,
  endDate: Schema.optional(Schema.NullOr(Schema.String)),
  autoPost: Schema.Boolean,
})

export const getForecast = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        month: Schema.optional(Schema.String),
        accountId: Schema.optional(Schema.String),
        withBudget: Schema.optional(Schema.Boolean),
      }),
    ),
  )
  .handler(({ data }) => runApp(ForecastService.use((s) => s.month(data))))

export const getUpcoming = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ accountId: Schema.optional(Schema.String), days: Schema.Int })))
  .handler(({ data }) => runApp(ForecastService.use((s) => s.upcoming(data))))

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

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Books due schedules. The browser sends its time zone so the server's "today" follows the user. */
export const syncSchedules = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ timeZone: Schema.optional(Schema.String) })))
  .handler(({ data }) =>
    runApp(
      Effect.gen(function* () {
        const settings = yield* Settings
        if (data.timeZone && isTimeZone(data.timeZone) && data.timeZone !== (yield* settings.get("timeZone"))) {
          yield* settings.set("timeZone", data.timeZone)
        }
        return yield* Schedules.use((s) => s.sync)
      }),
    ),
  )

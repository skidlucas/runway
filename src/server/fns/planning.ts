import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { addDays } from "~/domain/dates"
import { authMiddleware } from "../auth"
import { Invalid } from "../errors"
import { runApp } from "../runtime"
import { Cents, Day, Days, Id, Month, Name, PayeeInput, Recurrence } from "../schemas"
import { ForecastService } from "../services/forecast"
import { registerRows, Schedules } from "../services/schedules"
import { Settings } from "../services/settings"

const v = Schema.toStandardSchemaV1

const ScheduleInput = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Name)),
  payee: PayeeInput,
  accountId: Id,
  categoryId: Schema.NullOr(Id),
  amount: Cents,
  recurrence: Recurrence,
  startDate: Day,
  endDate: Schema.optional(Schema.NullOr(Day)),
  autoPost: Schema.Boolean,
})

export const getForecast = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        month: Schema.optional(Month),
        accountId: Schema.optional(Id),
      }),
    ),
  )
  .handler(({ data }) => runApp(ForecastService.use((s) => s.month(data))))

export const getUpcoming = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ accountId: Schema.optional(Id), days: Days })))
  .handler(({ data }) => runApp(ForecastService.use((s) => s.upcoming(data))))

/** Schedule occurrences shown as forecast lines at the top of a register. */
export const getScheduledRows = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ accountId: Schema.optional(Id), days: Days })))
  .handler(({ data }) =>
    runApp(
      Effect.gen(function* () {
        if (data.days < 0 || data.days > 366) return yield* new Invalid({ message: "Période invalide" })
        const today = yield* (yield* Settings).today
        const occurrences = yield* Schedules.use((s) => s.occurrences(today, addDays(today, data.days)))
        return { today, rows: registerRows(occurrences, data.accountId ?? null) }
      }),
    ),
  )

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
  .validator(v(Schema.Struct({ id: Id, input: ScheduleInput, active: Schema.optional(Schema.Boolean) })))
  .handler(({ data }) =>
    runApp(Schedules.use((s) => s.update(data.id, { ...data.input, ...(data.active === undefined ? {} : { active: data.active }) }))),
  )

export const deleteSchedule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id })))
  .handler(({ data }) => runApp(Schedules.use((s) => s.remove(data.id))))

export const skipSchedule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id })))
  .handler(({ data }) => runApp(Schedules.use((s) => s.skip(data.id))))

export const postSchedule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ id: Id, date: Schema.optional(Day) })))
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
  .validator(v(Schema.Struct({ timeZone: Schema.optional(Name) })))
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

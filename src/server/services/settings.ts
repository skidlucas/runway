import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { type Day, todayIn } from "~/domain/dates"
import { Db, type DbError } from "../db/client"
import { settings } from "../db/schema"

export type AppSettings = {
  timeZone: string
  /** Ids of the income category used for starting balances. */
  startingBalanceCategoryId: string | null
  aiEnabled: boolean
}

const DEFAULTS: AppSettings = {
  timeZone: "Europe/Paris",
  startingBalanceCategoryId: null,
  aiEnabled: true,
}

export class Settings extends Context.Service<
  Settings,
  {
    readonly all: Effect.Effect<AppSettings, DbError>
    get<K extends keyof AppSettings>(key: K): Effect.Effect<AppSettings[K], DbError>
    set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Effect.Effect<void, DbError>
    /** Today's date in the user's time zone (the worker itself runs in UTC). */
    readonly today: Effect.Effect<Day, DbError>
  }
>()("runway/server/services/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const db = yield* Db
      const all = db
        .use((orm) => orm.select().from(settings))
        .pipe(
          Effect.map((rows) => {
            const out: AppSettings = { ...DEFAULTS }
            for (const row of rows) {
              if (row.key in out) (out as Record<string, unknown>)[row.key] = row.value
            }
            return out
          }),
        )
      const get = <K extends keyof AppSettings>(key: K) =>
        db
          .use((orm) => orm.select().from(settings).where(eq(settings.key, key)).get())
          .pipe(Effect.map((row) => (row ? (row.value as AppSettings[K]) : DEFAULTS[key])))
      const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
        db
          .use((orm) =>
            orm.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }),
          )
          .pipe(Effect.asVoid)
      const today = get("timeZone").pipe(Effect.map((tz) => todayIn(tz)))
      return Settings.of({ all, get, set, today })
    }),
  )
}

import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { type Day, DEFAULT_TIME_ZONE, todayIn } from "~/domain/dates"
import { Db, type DbError } from "../db/client"
import { settings } from "../db/schema"

export type AppSettings = {
  timeZone: string
  /** Ids of the income category used for starting balances. */
  startingBalanceCategoryId: string | null
  aiEnabled: boolean
}

const DEFAULTS: AppSettings = {
  timeZone: DEFAULT_TIME_ZONE,
  startingBalanceCategoryId: null,
  aiEnabled: true,
}

// A stored value of the wrong shape (older version, manual edit) falls back to the default.
const isValid = {
  timeZone: Schema.is(Schema.String),
  startingBalanceCategoryId: Schema.is(Schema.NullOr(Schema.String)),
  aiEnabled: Schema.is(Schema.Boolean),
} satisfies { [K in keyof AppSettings]: (value: unknown) => value is AppSettings[K] }

const valueOf = <K extends keyof AppSettings>(key: K, value: unknown): AppSettings[K] =>
  (isValid[key] as (value: unknown) => value is AppSettings[K])(value) ? value : DEFAULTS[key]

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
            const stored = new Map(rows.map((r) => [r.key, r.value]))
            const keys = Object.keys(DEFAULTS) as Array<keyof AppSettings>
            return Object.fromEntries(keys.map((key) => [key, valueOf(key, stored.get(key))])) as AppSettings
          }),
        )
      const get = <K extends keyof AppSettings>(key: K) =>
        db
          .use((orm) => orm.select().from(settings).where(eq(settings.key, key)).get())
          .pipe(Effect.map((row) => (row ? valueOf(key, row.value) : DEFAULTS[key])))
      const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
        db
          .use((orm) =>
            orm.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }),
          )
          .pipe(Effect.asVoid)
      const today = Effect.all([get("timeZone"), Clock.currentTimeMillis], { concurrency: "unbounded" }).pipe(
        Effect.map(([tz, now]) => todayIn(tz, new Date(now))),
      )
      return Settings.of({ all, get, set, today })
    }),
  )
}

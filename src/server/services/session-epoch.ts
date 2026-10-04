import { Context, Effect, Layer } from "effect"
import { Db, type DbError } from "../db/client"

const KEY = "sessionEpoch"

/**
 * A counter stored in D1 and sealed into every session cookie: bumping it invalidates every
 * cookie issued before, which is how all devices get signed out.
 */
export class SessionEpoch extends Context.Service<
  SessionEpoch,
  {
    readonly current: Effect.Effect<number, DbError>
    /** Increments the epoch and returns the new one. */
    readonly bump: Effect.Effect<number, DbError>
  }
>()("runway/server/services/SessionEpoch") {
  static readonly layer = Layer.effect(
    SessionEpoch,
    Effect.gen(function* () {
      const db = yield* Db
      const current = db
        .use((_, d1) => d1.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>())
        .pipe(Effect.map((row) => Number(row?.value ?? 0) || 0))
      const bump = db
        .use((_, d1) =>
          d1
            .prepare(
              `INSERT INTO settings (key, value) VALUES (?1, '1')
               ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)
               RETURNING value`,
            )
            .bind(KEY)
            .first<{ value: string }>(),
        )
        .pipe(Effect.map((row) => Number(row?.value ?? 0)))
      return SessionEpoch.of({ current, bump })
    }),
  )
}

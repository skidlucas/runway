import { Context, Effect, Layer } from "effect"
import { Db, type DbError } from "../db/client"

// The app is a single password exposed on the internet: guesses are counted in D1 (shared by
// every isolate), and the account locks after too many.
const MAX_ATTEMPTS = 10
const LOCK_MS = 15 * 60 * 1000
const KEY = "loginGuard"

export class LoginGuard extends Context.Service<
  LoginGuard,
  {
    /**
     * Counts an attempt before the password is checked, so parallel guesses are all counted.
     * Returns when the lock ends if attempts are blocked, null otherwise.
     */
    attempt(now: number): Effect.Effect<number | null, DbError>
    /** Clears the counter after a successful login. */
    readonly succeeded: Effect.Effect<void, DbError>
  }
>()("runway/server/services/LoginGuard") {
  static readonly layer = Layer.effect(
    LoginGuard,
    Effect.gen(function* () {
      const db = yield* Db

      const attempt = Effect.fn("LoginGuard.attempt")(function* (now: number) {
        const row = yield* db.use((_, d1) =>
          d1
            .prepare(
              `INSERT INTO settings (key, value) VALUES (?1, json_object('attempts', 1, 'lockedUntil', 0))
               ON CONFLICT(key) DO UPDATE SET value = CASE
                 WHEN json_extract(settings.value, '$.lockedUntil') > ?2 THEN settings.value
                 WHEN json_extract(settings.value, '$.attempts') + 1 > ?3 THEN json_object('attempts', 0, 'lockedUntil', ?2 + ?4)
                 ELSE json_object('attempts', json_extract(settings.value, '$.attempts') + 1, 'lockedUntil', 0)
               END
               RETURNING json_extract(value, '$.lockedUntil') AS lockedUntil`,
            )
            .bind(KEY, now, MAX_ATTEMPTS, LOCK_MS)
            .first<{ lockedUntil: number }>(),
        )
        const lockedUntil = row?.lockedUntil ?? 0
        return lockedUntil > now ? lockedUntil : null
      })

      const succeeded = db
        .use((_, d1) => d1.prepare("DELETE FROM settings WHERE key = ?").bind(KEY).run())
        .pipe(Effect.asVoid)

      return LoginGuard.of({ attempt, succeeded })
    }),
  )
}

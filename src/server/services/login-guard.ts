import { Context, Effect, Layer } from "effect"
import { Db, type DbError } from "../db/client"

// The app is a single password exposed on the internet. Guesses are counted in D1 (shared by
// every isolate) per client, so one client hammering the form only locks itself out. A global
// counter with a much higher ceiling catches guessing spread over many addresses.
const MAX_ATTEMPTS = 10
const GLOBAL_MAX_ATTEMPTS = 100
const WINDOW_MS = 15 * 60 * 1000
const LOCK_MS = 15 * 60 * 1000
const GLOBAL_KEY = "global"

/**
 * The counter key for a request, from its `cf-connecting-ip` header. IPv6 clients usually own a
 * whole /64, so they are counted by prefix. Without the header (local dev) every request shares
 * one key.
 */
export const clientKey = (ip: string | undefined): string => {
  const address = ip?.trim().slice(0, 64)
  if (!address) return "ip:unknown"
  if (!address.includes(":")) return `ip:${address}`
  const [head = "", tail = ""] = address.toLowerCase().split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const groups = address.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left
  return `ip:${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`
}

// One upsert shape for both counters: inside an active lock nothing moves; once the window has
// passed (or a lock has ended) counting restarts; otherwise the attempt is counted and the key
// locks when it goes over its ceiling. `?1` key, `?2` now, `?3` ceiling, `?4` window, `?5` lock.
const upsert = (guard: string) => `
  INSERT INTO login_attempts (key, attempts, window_start, locked_until)
  SELECT ?1, 1, ?2, 0 WHERE ${guard}
  ON CONFLICT(key) DO UPDATE SET
    attempts = CASE
      WHEN locked_until > ?2 THEN attempts
      WHEN window_start <= ?2 - ?4 OR locked_until > 0 THEN 1
      ELSE attempts + 1 END,
    window_start = CASE
      WHEN locked_until > ?2 THEN window_start
      WHEN window_start <= ?2 - ?4 OR locked_until > 0 THEN ?2
      ELSE window_start END,
    locked_until = CASE
      WHEN locked_until > ?2 THEN locked_until
      WHEN window_start <= ?2 - ?4 OR locked_until > 0 THEN 0
      WHEN attempts + 1 > ?3 THEN ?2 + ?5
      ELSE 0 END`

// Attempts from a locked client are not counted globally, otherwise a single client could push
// the global counter over its ceiling and lock everyone out.
const COUNT_GLOBAL = upsert(
  "NOT EXISTS (SELECT 1 FROM login_attempts WHERE key = ?6 AND locked_until > ?2)",
)
// While the global lock holds no client row is created, which bounds the table's size.
const COUNT_CLIENT = upsert(
  `NOT EXISTS (SELECT 1 FROM login_attempts WHERE key = '${GLOBAL_KEY}' AND locked_until > ?2)`,
)

export class LoginGuard extends Context.Service<
  LoginGuard,
  {
    /**
     * Counts an attempt before the password is checked, so parallel guesses are all counted.
     * Returns when the lock ends if attempts from this client are blocked, null otherwise.
     */
    attempt(client: string, now: number): Effect.Effect<number | null, DbError>
    /** Clears the client's counter after a successful login. */
    succeeded(client: string): Effect.Effect<void, DbError>
  }
>()("runway/server/services/LoginGuard") {
  static readonly layer = Layer.effect(
    LoginGuard,
    Effect.gen(function* () {
      const db = yield* Db

      const attempt = Effect.fn("LoginGuard.attempt")(function* (client: string, now: number) {
        const results = yield* db.use((_, d1) =>
          d1.batch([
            d1.prepare(COUNT_GLOBAL).bind(GLOBAL_KEY, now, GLOBAL_MAX_ATTEMPTS, WINDOW_MS, LOCK_MS, client),
            d1.prepare(COUNT_CLIENT).bind(client, now, MAX_ATTEMPTS, WINDOW_MS, LOCK_MS),
            d1
              .prepare(
                `DELETE FROM login_attempts
                 WHERE key <> ?1 AND locked_until <= ?2 AND window_start <= ?2 - ?3`,
              )
              .bind(GLOBAL_KEY, now, WINDOW_MS),
            d1
              .prepare(`SELECT max(locked_until) AS lockedUntil FROM login_attempts WHERE key IN (?1, ?2)`)
              .bind(GLOBAL_KEY, client),
          ]),
        )
        const lockedUntil = (results[3]?.results[0] as { lockedUntil: number | null } | undefined)?.lockedUntil ?? 0
        return lockedUntil > now ? lockedUntil : null
      })

      const succeeded = (client: string) =>
        db
          .use((_, d1) => d1.prepare("DELETE FROM login_attempts WHERE key = ?").bind(client).run())
          .pipe(Effect.asVoid)

      return LoginGuard.of({ attempt, succeeded })
    }),
  )
}

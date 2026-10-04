import { and, asc, eq, lte } from "drizzle-orm"
import { Context, Effect, Layer, Option, Result, Schema } from "effect"
import { addDays, addMonths, type Day, diffDays, isDay } from "~/domain/dates"
import { describeRecurrence, nextOnOrAfter, occurrencesBetween, type Recurrence } from "~/domain/recurrence"
import { type Remaining, remainingOccurrences } from "~/domain/planned"
import { detectRecurring, type HistoryTransaction, type RecurringCandidate } from "~/domain/recurring-detection"
import { chunkRows, Db, type DbError, newId } from "../db/client"
import { schedules } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { Recurrence as RecurrenceSchema } from "../schemas"
import { Settings } from "./settings"
import { type NewTxRow, transactionInsertStatements, type TxPayeeInput, Transactions } from "./transactions"

// A stored rhythm that does not decode (old import, hand edit) must never yield guessed dates:
// such a schedule is listed as stopped, left out of the forecast and never booked.
const decodeRecurrence = Schema.decodeUnknownOption(Schema.fromJsonString(RecurrenceSchema))
const isRecurrence = Schema.is(RecurrenceSchema)
const UNREADABLE: Recurrence = { unit: "once", interval: 1 }

export type ScheduleDto = {
  id: string
  name: string | null
  payeeId: string | null
  payeeName: string | null
  accountId: string
  accountName: string
  categoryId: string | null
  categoryName: string | null
  amount: number
  recurrence: Recurrence
  recurrenceLabel: string
  startDate: string
  endDate: string | null
  nextDate: string
  autoPost: boolean
  active: boolean
  overdue: boolean
  /** Occurrences left until the end date; null without one or once stopped. */
  remaining: Remaining | null
}

export type ScheduleInput = {
  name?: string | null
  payee: TxPayeeInput
  accountId: string
  categoryId: string | null
  amount: number
  recurrence: Recurrence
  startDate: string
  endDate?: string | null
  autoPost: boolean
}

const MAX_OVERDUE = 12

// A booking of a sync is written only while its schedule still waits on the occurrence it read.
const stillDue = (id: string, from: string) =>
  `EXISTS (SELECT 1 FROM schedules cur WHERE cur.id = ${id} AND cur.next_date = ${from} AND cur.active = 1)`
const LINK_SQL = `UPDATE transactions SET schedule_id = l.value ->> 's' FROM json_each(?) l
  WHERE transactions.id = l.value ->> 't' AND transactions.schedule_id IS NULL AND ${stillDue("l.value ->> 's'", "l.value ->> 'from'")}`
const CLAIM_SQL = `UPDATE schedules SET next_date = c.value ->> 'next', active = c.value ->> 'active' FROM json_each(?) c
  WHERE schedules.id = c.value ->> 'id' AND schedules.next_date = c.value ->> 'from' AND schedules.active = 1
    AND json_array_length(c.value -> 'links') = (
      SELECT COUNT(*) FROM transactions t
      WHERE t.schedule_id = schedules.id AND t.id IN (SELECT value FROM json_each(c.value -> 'links')))
  RETURNING id`
const UNLINK_SQL = `UPDATE transactions SET schedule_id = NULL FROM json_each(?) l
  WHERE transactions.id = l.value ->> 't' AND transactions.schedule_id = l.value ->> 's' AND ${stillDue("l.value ->> 's'", "l.value ->> 'from'")}`

export type Occurrence = {
  scheduleId: string
  /** Set for a transfer schedule: the account on the other side. */
  transferAccountId: string | null
  date: Day
  /** The day it was due: before `date` when overdue. */
  dueDate: Day
  amount: number
  name: string
  categoryId: string | null
  accountId: string
  /** Due before `from` and still unpaid: dated `from` instead. */
  overdue: boolean
}

/** An occurrence as a line of an account register, from the side of that account. */
export type ScheduledRow = {
  scheduleId: string
  date: Day
  dueDate: Day
  name: string
  /** Signed for the register's account (or the schedule's own account when listing them all). */
  amount: number
  accountId: string
  categoryId: string | null
  transferAccountId: string | null
  overdue: boolean
  /** The next occurrence of its schedule: the only one that can be booked or skipped. */
  next: boolean
}

/** Newest first, like the register. A transfer shows on the receiving account with its sign flipped. */
export const registerRows = (occurrences: ReadonlyArray<Occurrence>, accountId: string | null): ScheduledRow[] => {
  const seen = new Set<string>()
  return [...occurrences]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .flatMap((o): ScheduledRow[] => {
      const incoming = accountId !== null && o.accountId !== accountId
      if (incoming && o.transferAccountId !== accountId) return []
      const next = !seen.has(o.scheduleId)
      seen.add(o.scheduleId)
      return [
        {
          scheduleId: o.scheduleId,
          date: o.date,
          dueDate: o.dueDate,
          name: o.name,
          amount: incoming ? -o.amount : o.amount,
          accountId: incoming ? accountId : o.accountId,
          categoryId: incoming ? null : o.categoryId,
          transferAccountId: incoming ? o.accountId : o.transferAccountId,
          overdue: o.overdue,
          next,
        },
      ]
    })
    .reverse()
}

export type RecurringSuggestion = RecurringCandidate & { accountName: string; categoryName: string | null }

type Row = typeof schedules.$inferSelect

export class Schedules extends Context.Service<
  Schedules,
  {
    readonly list: Effect.Effect<ScheduleDto[], DbError>
    create(input: ScheduleInput): Effect.Effect<string, DbError | Invalid | NotFound>
    update(id: string, input: ScheduleInput & { active?: boolean }): Effect.Effect<void, DbError | Invalid | NotFound>
    remove(id: string): Effect.Effect<void, DbError>
    /** Skips the next occurrence without booking it. */
    skip(id: string): Effect.Effect<void, DbError | NotFound | Invalid>
    /** Books the next occurrence as a transaction (dated today by default) and moves on. */
    post(id: string, date?: Day): Effect.Effect<string, DbError | NotFound | Invalid>
    /** Occurrences between two dates for active schedules, from their next date on. */
    occurrences(from: Day, to: Day): Effect.Effect<Occurrence[], DbError>
    /**
     * Books due auto-post schedules, and links manual schedules to a matching
     * transaction already entered or imported (same payee and account, close amount
     * and date), so "upcoming" never lists something already paid.
     */
    readonly sync: Effect.Effect<{ posted: number; matched: number }, DbError>
    readonly suggestions: Effect.Effect<RecurringSuggestion[], DbError>
  }
>()("runway/server/services/Schedules") {
  static readonly layer = Layer.effect(
    Schedules,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings
      const transactionsService = yield* Transactions

      const timing = (row: Pick<Row, "startDate" | "endDate" | "recurrence">) => ({
        startDate: row.startDate,
        endDate: row.endDate,
        recurrence: row.recurrence,
      })

      const list = Effect.gen(function* () {
        const today = yield* settings.today
        const rows = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `SELECT s.*, COALESCE(pa.name, p.name) AS payeeName, a.name AS accountName, c.name AS categoryName
               FROM schedules s
               JOIN accounts a ON a.id = s.account_id
               LEFT JOIN payees p ON p.id = s.payee_id
               LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
               LEFT JOIN categories c ON c.id = s.category_id
               ORDER BY s.active DESC, s.next_date`,
            )
            .all<{
              id: string
              name: string | null
              payee_id: string | null
              payeeName: string | null
              account_id: string
              accountName: string
              category_id: string | null
              categoryName: string | null
              amount: number
              recurrence: string
              start_date: string
              end_date: string | null
              next_date: string
              auto_post: number
              active: number
            }>()
          return results
        })
        return rows.map((r): ScheduleDto => {
          const decoded = decodeRecurrence(r.recurrence)
          const recurrence = Option.getOrElse(decoded, () => UNREADABLE)
          const active = r.active === 1 && Option.isSome(decoded)
          return {
            id: r.id,
            name: r.name,
            payeeId: r.payee_id,
            payeeName: r.payeeName,
            accountId: r.account_id,
            accountName: r.accountName,
            categoryId: r.category_id,
            categoryName: r.categoryName,
            amount: r.amount,
            recurrence,
            recurrenceLabel: Option.isSome(decoded) ? describeRecurrence(recurrence) : "Rythme illisible, à redéfinir",
            startDate: r.start_date,
            endDate: r.end_date,
            nextDate: r.next_date,
            autoPost: r.auto_post === 1,
            active,
            overdue: active && r.next_date < today,
            remaining: active ? remainingOccurrences({ startDate: r.start_date, endDate: r.end_date, recurrence }, r.next_date, r.amount) : null,
          }
        })
      }).pipe(Effect.withSpan("Schedules.list"))

      const validate = (input: ScheduleInput) => {
        if (!isDay(input.startDate)) return Effect.fail(new Invalid({ message: "Date de début invalide" }))
        if (input.endDate && !isDay(input.endDate)) return Effect.fail(new Invalid({ message: "Date de fin invalide" }))
        if (input.endDate && input.endDate < input.startDate) {
          return Effect.fail(new Invalid({ message: "La date de fin précède la date de début" }))
        }
        if (!Number.isInteger(input.amount) || input.amount === 0) {
          return Effect.fail(new Invalid({ message: "Montant invalide" }))
        }
        if (!Number.isInteger(input.recurrence.interval) || input.recurrence.interval < 1) {
          return Effect.fail(new Invalid({ message: "Fréquence invalide" }))
        }
        return Effect.void
      }

      const resolvePayeeId = (payee: TxPayeeInput, accountId: string) =>
        transactionsService.resolvePayee(payee, accountId).pipe(Effect.map((p) => p.payeeId))

      const create = Effect.fn("Schedules.create")(function* (input: ScheduleInput) {
        yield* validate(input)
        const payeeId = yield* resolvePayeeId(input.payee, input.accountId)
        const id = newId()
        yield* db.use((orm) =>
          orm.insert(schedules).values({
            id,
            name: input.name?.trim() || null,
            payeeId,
            accountId: input.accountId,
            categoryId: input.categoryId,
            amount: input.amount,
            recurrence: input.recurrence,
            startDate: input.startDate,
            endDate: input.endDate ?? null,
            nextDate: input.startDate,
            autoPost: input.autoPost,
          }),
        )
        return id
      })

      const readable = (row: Row) =>
        isRecurrence(row.recurrence)
          ? Effect.succeed(row)
          : Effect.fail(new Invalid({ message: "Le rythme enregistré de cette échéance est illisible : redéfinis-le" }))

      const find = (id: string) =>
        db
          .use((orm) => orm.select().from(schedules).where(eq(schedules.id, id)).get())
          .pipe(Effect.flatMap((r) => (r ? Effect.succeed(r) : Effect.fail(new NotFound({ entity: "Échéance", id })))))

      const update = Effect.fn("Schedules.update")(function* (id: string, input: ScheduleInput & { active?: boolean }) {
        yield* validate(input)
        const current = yield* find(id)
        const payeeId = yield* resolvePayeeId(input.payee, input.accountId)
        const today = yield* settings.today
        const rhythmChanged =
          current.startDate !== input.startDate || JSON.stringify(current.recurrence) !== JSON.stringify(input.recurrence)
        const next = { startDate: input.startDate, endDate: input.endDate ?? null, recurrence: input.recurrence }
        // A new rhythm restarts from the first occurrence that is not in the past. Otherwise the
        // schedule keeps its place, so an overdue occurrence is neither skipped nor booked twice;
        // only a new end date can stop it.
        // A one-off moved to a past day stays due (overdue), as when it is created there.
        const nextDate = rhythmChanged
          ? input.recurrence.unit === "once"
            ? input.startDate
            : nextOnOrAfter(next, input.startDate > today ? input.startDate : today)
          : nextOnOrAfter(next, current.nextDate)
        const ended = nextDate === null
        // Inactive with nothing left to book means it ran out, not that it was paused: a later end
        // date brings it back.
        const ranOut = !current.active && isRecurrence(current.recurrence) && nextOnOrAfter(timing(current), current.nextDate) === null
        const active = ended ? false : input.active ?? (ranOut ? true : undefined)
        yield* db.use((orm) =>
          orm
            .update(schedules)
            .set({
              name: input.name?.trim() || null,
              payeeId,
              accountId: input.accountId,
              categoryId: input.categoryId,
              amount: input.amount,
              recurrence: input.recurrence,
              startDate: input.startDate,
              endDate: input.endDate ?? null,
              nextDate: nextDate ?? current.nextDate,
              autoPost: input.autoPost,
              ...(active === undefined ? {} : { active }),
            })
            .where(eq(schedules.id, id)),
        )
      })

      const remove = (id: string) =>
        db
          .use(async (_, d1) => {
            await d1.batch([
              d1.prepare("UPDATE transactions SET schedule_id = NULL WHERE schedule_id = ?").bind(id),
              d1.prepare("DELETE FROM schedules WHERE id = ?").bind(id),
            ])
          })
          .pipe(Effect.asVoid, Effect.withSpan("Schedules.remove"))

      /** Where a schedule stands once its occurrence due on `nextDate` is booked or skipped. */
      const advance = (row: Row, nextDate: Day) => {
        const after = addDays(nextDate, 1)
        const next = nextOnOrAfter(timing(row), after)
        // An ended schedule keeps the first day it has not covered: pushing its end date later
        // resumes from there without booking the last occurrence again.
        return { nextDate: next ?? after, active: next !== null }
      }

      const skip = Effect.fn("Schedules.skip")(function* (id: string) {
        const row = yield* find(id).pipe(Effect.flatMap(readable))
        if (!row.active) return
        const next = advance(row, row.nextDate)
        yield* db.use((_, d1) =>
          d1
            .prepare("UPDATE schedules SET next_date = ?, active = ? WHERE id = ? AND next_date = ? AND active = 1")
            .bind(next.nextDate, next.active ? 1 : 0, row.id, row.nextDate)
            .run(),
        )
      })

      /**
       * What a sync (or a post) books for one schedule: new transactions dated `posts`, or existing
       * ones (`links`) that paid its occurrences, and where the schedule then stands. `row.nextDate`
       * is where it stood when read.
       */
      type Booking = {
        readonly row: Row
        readonly posts: ReadonlyArray<Day>
        readonly links: ReadonlyArray<string>
        readonly next: { readonly nextDate: Day; readonly active: boolean }
      }
      type ReadyBooking = Booking & { readonly rows: ReadonlyArray<NewTxRow>; readonly txIds: ReadonlyArray<string> }

      /** The transactions of every booking, prepared together; a booking that cannot be prepared gets its error. */
      const prepareBookings = Effect.fn("Schedules.prepareBookings")(function* (bookings: ReadonlyArray<Booking>) {
        const prepared = yield* transactionsService.prepareMany(
          bookings.flatMap(({ row, posts }) =>
            posts.map((date) => ({
              accountId: row.accountId,
              date,
              amount: row.amount,
              payee: row.payeeId ? ({ kind: "id", id: row.payeeId } as const) : ({ kind: "none" } as const),
              categoryId: row.categoryId,
              notes: row.name,
              scheduleId: row.id,
            })),
          ),
        )
        let offset = 0
        return bookings.map((booking): Result.Result<ReadyBooking, DbError | Invalid | NotFound> => {
          const own = prepared.slice(offset, (offset += booking.posts.length))
          const failed = own.find(Result.isFailure)
          if (failed) return Result.fail(failed.failure)
          const txs = own.flatMap((r) => (Result.isSuccess(r) ? [r.success] : []))
          return Result.succeed({ ...booking, rows: txs.flatMap((t) => t.rows), txIds: txs.map((t) => t.id) })
        })
      })

      /**
       * Writes bookings in one batch and returns the ids of the schedules it moved on. A booking only
       * takes effect while its schedule still stands where it was read: when another sync or tab
       * booked or skipped that occurrence meanwhile, none of its rows is written. Its claim also
       * checks that every matched transaction was linked to it (none was taken meanwhile), else
       * those links are undone.
       */
      const writeBookings = (bookings: ReadonlyArray<ReadyBooking>) =>
        db.use(async (_, d1) => {
          const guards = new Map(bookings.flatMap((b) => b.rows.map((r) => [r.id, { s: b.row.id, from: b.row.nextDate }] as const)))
          const links = chunkRows(bookings.flatMap((b) => b.links.map((t) => ({ t, s: b.row.id, from: b.row.nextDate })))).map((c) =>
            JSON.stringify(c),
          )
          const claims = chunkRows(
            bookings.map((b) => ({ id: b.row.id, from: b.row.nextDate, next: b.next.nextDate, active: b.next.active ? 1 : 0, links: b.links })),
          ).map((c) => d1.prepare(CLAIM_SQL).bind(JSON.stringify(c)))
          const inserts = transactionInsertStatements(
            d1,
            bookings.flatMap((b) => b.rows),
            { where: stillDue("value ->> '$[#-1].s'", "value ->> '$[#-1].from'"), of: (r) => guards.get(r.id) },
          )
          const firstClaim = inserts.length + links.length
          const results = await d1.batch([
            ...inserts,
            ...links.map((json) => d1.prepare(LINK_SQL).bind(json)),
            ...claims,
            ...links.map((json) => d1.prepare(UNLINK_SQL).bind(json)),
          ])
          return new Set(
            results.slice(firstClaim, firstClaim + claims.length).flatMap((r) => (r.results as Array<{ id: string }>).map((c) => c.id)),
          )
        })

      /** Writes bookings; when the batch fails, retries them one at a time so that one broken schedule does not hold back the others. */
      const commit = (bookings: ReadonlyArray<ReadyBooking>) =>
        bookings.length === 0
          ? Effect.succeed(new Set<string>())
          : writeBookings(bookings).pipe(
              Effect.catch((error) =>
                bookings.length === 1
                  ? Effect.fail(error)
                  : Effect.forEach(bookings, (b) =>
                      writeBookings([b]).pipe(
                        Effect.catch((e) => Effect.logWarning("Échéance ignorée", { id: b.row.id, error: e }).pipe(Effect.as(new Set<string>()))),
                      ),
                    ).pipe(Effect.map((sets) => new Set(sets.flatMap((s) => [...s])))),
              ),
            )

      const post = Effect.fn("Schedules.post")(function* (id: string, date?: Day) {
        if (date !== undefined && !isDay(date)) return yield* new Invalid({ message: "Date invalide" })
        const row = yield* find(id).pipe(Effect.flatMap(readable))
        if (!row.active) return yield* new Invalid({ message: "Cette échéance est terminée" })
        const today = yield* settings.today
        const posts = [date ?? (row.nextDate <= today ? row.nextDate : today)]
        const prepared = (yield* prepareBookings([{ row, posts, links: [], next: advance(row, row.nextDate) }]))[0]!
        if (Result.isFailure(prepared)) return yield* Effect.fail(prepared.failure)
        const claimed = yield* commit([prepared.success])
        if (!claimed.has(row.id)) return yield* new Invalid({ message: "Cette échéance vient déjà d'être passée" })
        return prepared.success.txIds[0]!
      })

      const occurrences = (from: Day, to: Day) =>
        db
          .use(async (_, d1) => {
            const { results } = await d1
              .prepare(
                `SELECT s.*, COALESCE(s.name, pa.name, p.name) AS label, p.transfer_account_id
                 FROM schedules s
                 LEFT JOIN payees p ON p.id = s.payee_id
                 LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
                 WHERE s.active = 1 AND s.next_date <= ?`,
              )
              .bind(to)
              .all<{
                id: string
                label: string | null
                transfer_account_id: string | null
                account_id: string
                category_id: string | null
                amount: number
                recurrence: string
                start_date: string
                end_date: string | null
                next_date: string
              }>()
            return results
          })
          .pipe(
            Effect.map((rows) =>
              rows.flatMap((r) => {
                const recurrence = decodeRecurrence(r.recurrence)
                if (Option.isNone(recurrence)) return []
                const t = { startDate: r.start_date, endDate: r.end_date, recurrence: recurrence.value }
                const start = r.next_date > from ? r.next_date : from
                // Overdue occurrences (before `from`) still count: they have not been paid yet. The cap
                // keeps a long-forgotten daily schedule from flooding the register.
                const overdue = r.next_date < from ? occurrencesBetween(t, r.next_date, addDays(from, -1), MAX_OVERDUE) : []
                return [...overdue, ...occurrencesBetween(t, start, to)].map((date) => ({
                  scheduleId: r.id,
                  transferAccountId: r.transfer_account_id,
                  date: date < from ? from : date,
                  dueDate: date,
                  overdue: date < from,
                  amount: r.amount,
                  name: r.label ?? "Échéance",
                  categoryId: r.category_id,
                  accountId: r.account_id,
                }))
              }),
            ),
            Effect.withSpan("Schedules.occurrences"),
          )

      // Bounds the work of one request: a long absence is caught up over the next syncs.
      const MAX_POSTS_PER_SYNC = 40
      // Manual schedules due within these days are linked to a payment already there.
      const MATCH_LOOKAHEAD_DAYS = 5
      // How far from its due date a payment still counts for an occurrence.
      const MATCH_WINDOW_DAYS = 6
      const MAX_MATCHES_PER_SCHEDULE = 12

      const matchTolerance = (amount: number) => Math.max(Math.round(Math.abs(amount) * 0.1), 100)

      /**
       * Manual schedules paid by a transaction entered or imported by hand: same payee and account,
       * a close amount, dated near the occurrence. Candidates are read in one query; the closest one
       * pays each occurrence, and a transaction pays one occurrence at most.
       */
      const matchPayments = Effect.fn("Schedules.matchPayments")(function* (rows: ReadonlyArray<Row>, today: Day) {
        const horizon = addDays(today, MATCH_LOOKAHEAD_DAYS)
        const wanted = rows.flatMap((row) => {
          const dates: Day[] = []
          let next = { nextDate: row.nextDate, active: row.active }
          while (next.active && next.nextDate <= horizon && dates.length < MAX_MATCHES_PER_SCHEDULE) {
            dates.push(next.nextDate)
            next = advance(row, next.nextDate)
          }
          return dates.length > 0 ? [{ row, dates }] : []
        })
        if (wanted.length === 0) return []
        const candidates = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `SELECT w.value ->> 'id' AS scheduleId, t.id, t.date FROM json_each(?) w
               JOIN transactions t ON t.payee_id = w.value ->> 'payeeId' AND t.account_id = w.value ->> 'accountId'
               WHERE t.schedule_id IS NULL AND t.parent_id IS NULL
                 AND ABS(t.amount - (w.value ->> 'amount')) <= w.value ->> 'tolerance'
                 AND t.date BETWEEN w.value ->> 'from' AND w.value ->> 'to'`,
            )
            .bind(
              JSON.stringify(
                wanted.map(({ row, dates }) => ({
                  id: row.id,
                  payeeId: row.payeeId,
                  accountId: row.accountId,
                  amount: row.amount,
                  tolerance: matchTolerance(row.amount),
                  from: addDays(dates[0]!, -MATCH_WINDOW_DAYS),
                  to: addDays(dates.at(-1)!, MATCH_WINDOW_DAYS),
                })),
              ),
            )
            .all<{ scheduleId: string; id: string; date: Day }>()
          return results
        })
        const bySchedule = new Map<string, Array<{ id: string; date: Day }>>()
        for (const c of candidates) {
          const list = bySchedule.get(c.scheduleId)
          if (list) list.push(c)
          else bySchedule.set(c.scheduleId, [c])
        }
        const used = new Set<string>()
        return wanted.flatMap(({ row, dates }): Booking[] => {
          const own = bySchedule.get(row.id) ?? []
          const links: string[] = []
          for (const date of dates) {
            const distance = (t: { date: Day }) => Math.abs(diffDays(date, t.date))
            const best = own
              .filter((t) => !used.has(t.id) && distance(t) <= MATCH_WINDOW_DAYS)
              .sort((a, b) => distance(a) - distance(b) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0]
            if (!best) break
            used.add(best.id)
            links.push(best.id)
          }
          return links.length > 0 ? [{ row, posts: [], links, next: advance(row, dates[links.length - 1]!) }] : []
        })
      })

      const sync = Effect.gen(function* () {
        const today = yield* settings.today
        const due = yield* db.use((orm) =>
          orm
            .select()
            .from(schedules)
            .where(and(eq(schedules.active, true), lte(schedules.nextDate, addDays(today, MATCH_LOOKAHEAD_DAYS))))
            .orderBy(asc(schedules.nextDate)),
        )
        const bookings: Booking[] = []
        const manual: Row[] = []
        let posts = 0
        for (const row of due) {
          if (!isRecurrence(row.recurrence)) {
            yield* Effect.logWarning("Échéance ignorée : rythme illisible", { id: row.id })
            continue
          }
          if (!row.autoPost) {
            if (row.payeeId) manual.push(row)
            continue
          }
          const dates: Day[] = []
          let next = { nextDate: row.nextDate, active: row.active }
          while (next.active && next.nextDate <= today && posts < MAX_POSTS_PER_SYNC) {
            dates.push(next.nextDate)
            posts++
            next = advance(row, next.nextDate)
          }
          if (dates.length > 0) bookings.push({ row, posts: dates, links: [], next })
        }
        bookings.push(...(yield* matchPayments(manual, today)))

        const ready: ReadyBooking[] = []
        for (const prepared of yield* prepareBookings(bookings)) {
          // One broken schedule (a deleted account, a transfer to itself) must not block the others.
          if (Result.isSuccess(prepared)) ready.push(prepared.success)
          else yield* Effect.logWarning("Échéance ignorée", { error: prepared.failure })
        }
        const claimed = yield* commit(ready).pipe(
          Effect.catch((error) => Effect.logWarning("Échéance ignorée", { error }).pipe(Effect.as(new Set<string>()))),
        )
        const booked = ready.filter((b) => claimed.has(b.row.id))
        return {
          posted: booked.reduce((n, b) => n + b.posts.length, 0),
          matched: booked.reduce((n, b) => n + b.links.length, 0),
        }
      }).pipe(Effect.withSpan("Schedules.sync"))

      const suggestions = Effect.gen(function* () {
        const today = yield* settings.today
        const since = `${addMonths(today.slice(0, 7), -13)}-01`
        const history = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              // Only (payee, account, direction) groups seen at least 3 times can be recurring:
              // the rest of the history never leaves SQLite.
              `WITH g AS (
                 SELECT payee_id, account_id, amount < 0 AS outflow FROM transactions
                 WHERE date >= ?1 AND date <= ?2 AND parent_id IS NULL AND starting_balance = 0 AND payee_id IS NOT NULL
                 GROUP BY 1, 2, 3 HAVING COUNT(*) >= 3
               )
               SELECT t.payee_id AS payeeId, p.name AS payeeName, t.date, t.amount, t.category_id AS categoryId,
                      t.account_id AS accountId
               FROM transactions t
               JOIN g ON g.payee_id = t.payee_id AND g.account_id = t.account_id AND g.outflow = (t.amount < 0)
               JOIN payees p ON p.id = t.payee_id
               WHERE t.date >= ?1 AND t.date <= ?2 AND t.parent_id IS NULL AND p.transfer_account_id IS NULL
                 AND t.starting_balance = 0`,
            )
            .bind(since, today)
            .all<HistoryTransaction>()
          return results
        })
        const [existing, names] = yield* Effect.all([
          db.use((orm) => orm.select({ payeeId: schedules.payeeId, accountId: schedules.accountId }).from(schedules)),
          db
            .use((_, d1) => d1.batch([d1.prepare("SELECT id, name FROM accounts"), d1.prepare("SELECT id, name FROM categories")]))
            .pipe(
              Effect.map(([acc, cat]) => ({
                accounts: new Map(((acc?.results ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])),
                categories: new Map(((cat?.results ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name])),
              })),
            ),
        ], { concurrency: "unbounded" })
        const scheduled = new Set(existing.map((e) => `${e.payeeId}|${e.accountId}`))
        return detectRecurring(history, today)
          .filter((c) => !scheduled.has(`${c.payeeId}|${c.accountId}`))
          .filter((c) => diffDays(c.lastDate, today) <= 45 || c.recurrence.unit !== "month")
          .map((c) => ({
            ...c,
            accountName: names.accounts.get(c.accountId) ?? "",
            categoryName: c.categoryId ? (names.categories.get(c.categoryId) ?? null) : null,
          }))
      }).pipe(Effect.withSpan("Schedules.suggestions"))

      return Schedules.of({ list, create, update, remove, skip, post, occurrences, sync, suggestions })
    }),
  )
}

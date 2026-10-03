import { and, asc, eq, lte } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { addDays, addMonths, type Day, diffDays, isDay } from "~/domain/dates"
import { describeRecurrence, nextOnOrAfter, occurrencesBetween, type Recurrence } from "~/domain/recurrence"
import { detectRecurring, type HistoryTransaction, type RecurringCandidate } from "~/domain/recurring-detection"
import { Db, type DbError, newId } from "../db/client"
import { schedules } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { Payees } from "./payees"
import { Settings } from "./settings"
import { type TxPayeeInput, Transactions } from "./transactions"

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

export type Occurrence = {
  scheduleId: string
  /** Set for a transfer schedule: the account on the other side. */
  transferAccountId: string | null
  date: Day
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
    skip(id: string): Effect.Effect<void, DbError | NotFound>
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
      const payeesService = yield* Payees

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
          const recurrence = JSON.parse(r.recurrence) as Recurrence
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
            recurrenceLabel: describeRecurrence(recurrence),
            startDate: r.start_date,
            endDate: r.end_date,
            nextDate: r.next_date,
            autoPost: r.auto_post === 1,
            active: r.active === 1,
            overdue: r.active === 1 && r.next_date < today,
          }
        })
      })

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

      const resolvePayeeId = Effect.fn("Schedules.resolvePayeeId")(function* (payee: TxPayeeInput, accountId: string) {
        switch (payee.kind) {
          case "none":
            return null
          case "id": {
            const found = yield* db.use((_, d1) =>
              d1.prepare("SELECT transfer_account_id AS t FROM payees WHERE id = ?").bind(payee.id).first<{ t: string | null }>(),
            )
            if (!found) return yield* new NotFound({ entity: "Bénéficiaire", id: payee.id })
            if (found.t === accountId) return yield* new Invalid({ message: "Un virement doit viser un autre compte" })
            return payee.id
          }
          case "name": {
            const ids = yield* payeesService.resolveNames([payee.name])
            return ids.get(payee.name) ?? null
          }
          case "transfer":
            if (payee.accountId === accountId) return yield* new Invalid({ message: "Un virement doit viser un autre compte" })
            return yield* transactionsService.transferPayee(payee.accountId)
        }
      })

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
              ...(ended ? { active: false } : input.active === undefined ? {} : { active: input.active }),
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
          .pipe(Effect.asVoid)

      /**
       * Moves the schedule past its current occurrence, only if nobody did it meanwhile
       * (another tab, a second sync). Returns the schedule as it now stands, or null when
       * the occurrence was already taken: the caller must then not book it.
       */
      const claim = Effect.fn("Schedules.claim")(function* (row: Row) {
        const next = nextOnOrAfter(timing(row), addDays(row.nextDate, 1))
        const result = yield* db.use((_, d1) =>
          d1
            .prepare("UPDATE schedules SET next_date = ?, active = ? WHERE id = ? AND next_date = ? AND active = 1")
            .bind(next ?? row.nextDate, next === null ? 0 : 1, row.id, row.nextDate)
            .run(),
        )
        if (result.meta.changes !== 1) return null
        const claimed: Row = { ...row, nextDate: next ?? row.nextDate, active: next !== null }
        return claimed
      })

      const release = (row: Row, claimed: Row) =>
        db.use((_, d1) =>
          d1
            .prepare("UPDATE schedules SET next_date = ?, active = 1 WHERE id = ? AND next_date = ? AND active = ?")
            .bind(row.nextDate, row.id, claimed.nextDate, claimed.active ? 1 : 0)
            .run(),
        )

      const skip = Effect.fn("Schedules.skip")(function* (id: string) {
        const row = yield* find(id)
        if (row.active) yield* claim(row)
      })

      const payeeInputOf = Effect.fn("Schedules.payeeInputOf")(function* (row: Row) {
        if (!row.payeeId) return { kind: "none" } satisfies TxPayeeInput
        const payee = yield* db.use((_, d1) =>
          d1.prepare("SELECT transfer_account_id AS t FROM payees WHERE id = ?").bind(row.payeeId).first<{ t: string | null }>(),
        )
        return (payee?.t ? { kind: "transfer", accountId: payee.t } : { kind: "id", id: row.payeeId }) satisfies TxPayeeInput
      })

      /** Books the current occurrence of `row`. Null when it was already booked or skipped. */
      const postRow = Effect.fn("Schedules.postRow")(function* (row: Row, date: Day, payee: TxPayeeInput) {
        const claimed = yield* claim(row)
        if (!claimed) return null
        const txId = yield* transactionsService
          .create({
            accountId: row.accountId,
            date,
            amount: row.amount,
            payee,
            categoryId: row.categoryId,
            notes: row.name,
            scheduleId: row.id,
          })
          .pipe(Effect.onError(() => release(row, claimed).pipe(Effect.ignore({ log: "Warn", message: "Échéance non rétablie après un échec" }))))
        return { txId, row: claimed }
      })

      const post = Effect.fn("Schedules.post")(function* (id: string, date?: Day) {
        if (date !== undefined && !isDay(date)) return yield* new Invalid({ message: "Date invalide" })
        const row = yield* find(id)
        if (!row.active) return yield* new Invalid({ message: "Cette échéance est terminée" })
        const today = yield* settings.today
        const posted = yield* postRow(row, date ?? (row.nextDate <= today ? row.nextDate : today), yield* payeeInputOf(row))
        if (!posted) return yield* new Invalid({ message: "Cette échéance vient déjà d'être passée" })
        return posted.txId
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
                const t = { startDate: r.start_date, endDate: r.end_date, recurrence: JSON.parse(r.recurrence) as Recurrence }
                const start = r.next_date > from ? r.next_date : from
                // Overdue occurrences (before `from`) still count: they have not been paid yet.
                const overdue = r.next_date < from ? [r.next_date] : []
                return [...overdue, ...occurrencesBetween(t, start, to)].map((date) => ({
                  scheduleId: r.id,
                  transferAccountId: r.transfer_account_id,
                  date: date < from ? from : date,
                  overdue: date < from,
                  amount: r.amount,
                  name: r.label ?? "Échéance",
                  categoryId: r.category_id,
                  accountId: r.account_id,
                }))
              }),
            ),
          )

      // Bounds the work of one request (Workers cap queries per invocation): a long absence is
      // caught up over the next syncs.
      const MAX_POSTS_PER_SYNC = 40

      const syncOne = Effect.fn("Schedules.syncOne")(function* (original: Row, today: Day, budget: { posts: number }) {
        let row = original
        let posted = 0
        let matched = 0
        if (row.autoPost) {
          const payee = yield* payeeInputOf(row)
          while (row.active && row.nextDate <= today && budget.posts < MAX_POSTS_PER_SYNC) {
            budget.posts++
            const done = yield* postRow(row, row.nextDate, payee)
            if (!done) break
            posted++
            row = done.row
          }
          return { posted, matched }
        }
        if (!row.payeeId) return { posted, matched }
        for (let i = 0; i < 12 && row.active && row.nextDate <= addDays(today, 5); i++) {
          const tolerance = Math.max(Math.round(Math.abs(row.amount) * 0.1), 100)
          const match = yield* db.use((_, d1) =>
            d1
              .prepare(
                `SELECT id FROM transactions
                 WHERE payee_id = ? AND account_id = ? AND schedule_id IS NULL AND parent_id IS NULL
                   AND ABS(amount - ?) <= ? AND date BETWEEN ? AND ?
                 ORDER BY ABS(julianday(date) - julianday(?)) LIMIT 1`,
              )
              .bind(row.payeeId, row.accountId, row.amount, tolerance, addDays(row.nextDate, -6), addDays(row.nextDate, 6), row.nextDate)
              .first<{ id: string }>(),
          )
          if (!match) break
          const claimed = yield* claim(row)
          if (!claimed) break
          yield* db.use((_, d1) =>
            d1.prepare("UPDATE transactions SET schedule_id = ? WHERE id = ? AND schedule_id IS NULL").bind(row.id, match.id).run(),
          )
          matched++
          row = claimed
        }
        return { posted, matched }
      })

      const sync = Effect.gen(function* () {
        const today = yield* settings.today
        const due = yield* db.use((orm) =>
          orm
            .select()
            .from(schedules)
            .where(and(eq(schedules.active, true), lte(schedules.nextDate, addDays(today, 5))))
            .orderBy(asc(schedules.nextDate)),
        )
        const budget = { posts: 0 }
        let posted = 0
        let matched = 0
        for (const row of due) {
          // One broken schedule (a deleted account, a transfer to itself) must not block the others.
          const result = yield* syncOne(row, today, budget).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Échéance ignorée", { id: row.id, error }).pipe(Effect.as({ posted: 0, matched: 0 })),
            ),
          )
          posted += result.posted
          matched += result.matched
        }
        return { posted, matched }
      })

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
          db.use(async (_, d1) => {
            const [acc, cat] = await d1.batch([
              d1.prepare("SELECT id, name FROM accounts"),
              d1.prepare("SELECT id, name FROM categories"),
            ])
            return {
              accounts: new Map(((acc?.results ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])),
              categories: new Map(((cat?.results ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name])),
            }
          }),
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
      })

      return Schedules.of({ list, create, update, remove, skip, post, occurrences, sync, suggestions })
    }),
  )
}

import { asc, eq } from "drizzle-orm"
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
  date: Day
  amount: number
  name: string
  categoryId: string | null
  accountId: string
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
    readonly sync: Effect.Effect<{ posted: number; matched: number }, DbError | Invalid | NotFound>
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

      const resolvePayeeId = Effect.fn("Schedules.resolvePayeeId")(function* (payee: TxPayeeInput) {
        switch (payee.kind) {
          case "none":
            return null
          case "id":
            return payee.id
          case "name": {
            const ids = yield* payeesService.resolveNames([payee.name])
            return ids.get(payee.name) ?? null
          }
          case "transfer":
            return yield* transactionsService.transferPayee(payee.accountId)
        }
      })

      const create = Effect.fn("Schedules.create")(function* (input: ScheduleInput) {
        yield* validate(input)
        const payeeId = yield* resolvePayeeId(input.payee)
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
        const payeeId = yield* resolvePayeeId(input.payee)
        const today = yield* settings.today
        const timingChanged =
          current.startDate !== input.startDate ||
          JSON.stringify(current.recurrence) !== JSON.stringify(input.recurrence) ||
          current.endDate !== (input.endDate ?? null)
        // A new rhythm restarts from the first occurrence that is not in the past.
        const nextDate = timingChanged
          ? (nextOnOrAfter(
              { startDate: input.startDate, endDate: input.endDate ?? null, recurrence: input.recurrence },
              input.startDate > today ? input.startDate : today,
            ) ?? input.startDate)
          : current.nextDate
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
              nextDate,
              autoPost: input.autoPost,
              ...(input.active === undefined ? {} : { active: input.active }),
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

      const advance = (row: Row) => {
        const next = nextOnOrAfter(timing(row), addDays(row.nextDate, 1))
        return next === null
          ? db.use((orm) => orm.update(schedules).set({ active: false }).where(eq(schedules.id, row.id)))
          : db.use((orm) => orm.update(schedules).set({ nextDate: next }).where(eq(schedules.id, row.id)))
      }

      const skip = Effect.fn("Schedules.skip")(function* (id: string) {
        const row = yield* find(id)
        yield* advance(row)
      })

      const postRow = Effect.fn("Schedules.postRow")(function* (row: Row, date: Day) {
        const payee = row.payeeId
          ? yield* db.use((_, d1) =>
              d1.prepare("SELECT transfer_account_id AS t FROM payees WHERE id = ?").bind(row.payeeId).first<{ t: string | null }>(),
            )
          : null
        const payeeInput: TxPayeeInput = !row.payeeId
          ? { kind: "none" }
          : payee?.t
            ? { kind: "transfer", accountId: payee.t }
            : { kind: "id", id: row.payeeId }
        const txId = yield* transactionsService.create({
          accountId: row.accountId,
          date,
          amount: row.amount,
          payee: payeeInput,
          categoryId: row.categoryId,
          notes: row.name,
          scheduleId: row.id,
        })
        yield* advance(row)
        return txId
      })

      const post = Effect.fn("Schedules.post")(function* (id: string, date?: Day) {
        const row = yield* find(id)
        if (!row.active) return yield* new Invalid({ message: "Cette échéance est terminée" })
        const today = yield* settings.today
        return yield* postRow(row, date ?? (row.nextDate <= today ? row.nextDate : today))
      })

      const occurrences = (from: Day, to: Day) =>
        db
          .use(async (_, d1) => {
            const { results } = await d1
              .prepare(
                `SELECT s.*, COALESCE(s.name, pa.name, p.name) AS label
                 FROM schedules s
                 LEFT JOIN payees p ON p.id = s.payee_id
                 LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
                 WHERE s.active = 1 AND s.next_date <= ?`,
              )
              .bind(to)
              .all<{
                id: string
                label: string | null
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
                  date: date < from ? from : date,
                  amount: r.amount,
                  name: r.label ?? "Échéance",
                  categoryId: r.category_id,
                  accountId: r.account_id,
                }))
              }),
            ),
          )

      const sync = Effect.gen(function* () {
        const today = yield* settings.today
        const due = yield* db.use((orm) =>
          orm.select().from(schedules).where(eq(schedules.active, true)).orderBy(asc(schedules.nextDate)),
        )
        let posted = 0
        let matched = 0
        for (const original of due) {
          let row = original
          if (row.autoPost) {
            // Book every missed occurrence, bounded in case of a very old start date.
            for (let i = 0; i < 36 && row.active && row.nextDate <= today; i++) {
              yield* postRow(row, row.nextDate)
              posted++
              const refreshed = yield* db.use((orm) => orm.select().from(schedules).where(eq(schedules.id, row.id)).get())
              if (!refreshed) break
              row = refreshed
            }
            continue
          }
          if (row.nextDate > addDays(today, 5) || !row.payeeId) continue
          for (let i = 0; i < 12 && row.nextDate <= addDays(today, 5); i++) {
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
            yield* db.use((_, d1) => d1.prepare("UPDATE transactions SET schedule_id = ? WHERE id = ?").bind(row.id, match.id).run())
            yield* advance(row)
            matched++
            const refreshed = yield* db.use((orm) => orm.select().from(schedules).where(eq(schedules.id, row.id)).get())
            if (!refreshed || !refreshed.active) break
            row = refreshed
          }
        }
        return { posted, matched }
      })

      const suggestions = Effect.gen(function* () {
        const today = yield* settings.today
        const since = `${addMonths(today.slice(0, 7), -13)}-01`
        const history = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `SELECT t.payee_id AS payeeId, p.name AS payeeName, t.date, t.amount, t.category_id AS categoryId,
                      t.account_id AS accountId
               FROM transactions t JOIN payees p ON p.id = t.payee_id
               WHERE t.date >= ? AND t.date <= ? AND t.parent_id IS NULL AND p.transfer_account_id IS NULL
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
        ])
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

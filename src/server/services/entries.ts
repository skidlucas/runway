import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { type Day, isDay } from "~/domain/dates"
import { Db, type DbError } from "../db/client"
import { accounts, payees, transactions } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { type ScheduleInput, Schedules } from "./schedules"
import { Settings } from "./settings"
import { type TxInput, type TxPatch, type TxPayeeInput, Transactions } from "./transactions"

/** Where an entry ended up: a transaction when dated today or before, a one-off schedule after. */
export type Recorded = { kind: "transaction"; id: string } | { kind: "schedule"; id: string; date: Day }

const ONCE = { unit: "once", interval: 1 } as const

/**
 * The single way the app records or re-dates an operation: what happens after today is not an
 * operation yet but a one-off schedule, confirmed by hand once it really happens (its day often
 * moves by one or two).
 */
export class Entries extends Context.Service<
  Entries,
  {
    record(input: TxInput): Effect.Effect<Recorded, DbError | Invalid | NotFound>
    /** Edits a transaction; moved after today, it is replaced by a one-off schedule. */
    amend(id: string, patch: TxPatch): Effect.Effect<Recorded, DbError | Invalid | NotFound>
  }
>()("runway/server/services/Entries") {
  static readonly layer = Layer.effect(
    Entries,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings
      const transactionsService = yield* Transactions
      const schedulesService = yield* Schedules

      const isFuture = (date: string | undefined) =>
        date === undefined || !isDay(date) ? Effect.succeed(false) : settings.today.pipe(Effect.map((today) => date > today))

      /** The one-off schedule standing for `input`, with the payee and category a transaction would get. */
      const scheduleOf = Effect.fn("Entries.scheduleOf")(function* (input: TxInput) {
        if (input.splits?.length) return yield* new Invalid({ message: "Une opération ventilée ne peut pas être datée dans le futur" })
        const entry = yield* transactionsService.resolveEntry(input)
        return {
          name: null,
          payee: entry.payeeId ? { kind: "id", id: entry.payeeId } : { kind: "none" },
          accountId: input.accountId,
          categoryId: entry.categoryId,
          amount: input.amount,
          notes: entry.notes,
          recurrence: ONCE,
          startDate: input.date,
          autoPost: false,
        } satisfies ScheduleInput
      })

      const record = Effect.fn("Entries.record")(function* (input: TxInput) {
        if (!(yield* isFuture(input.date))) return { kind: "transaction", id: yield* transactionsService.create(input) } satisfies Recorded
        const id = yield* schedulesService.create(yield* scheduleOf(input))
        return { kind: "schedule", id, date: input.date } satisfies Recorded
      })

      const amend = Effect.fn("Entries.amend")(function* (id: string, patch: TxPatch) {
        if (!(yield* isFuture(patch.date))) {
          yield* transactionsService.update(id, patch)
          return { kind: "transaction", id } satisfies Recorded
        }
        const current = yield* db.use((orm) => orm.select().from(transactions).where(eq(transactions.id, id)).get())
        if (!current) return yield* new NotFound({ entity: "Opération", id })
        if (current.parentId || current.isParent || patch.splits?.length) {
          return yield* new Invalid({ message: "Une opération ventilée ne peut pas être datée dans le futur" })
        }
        if (current.reconciled) return yield* new Invalid({ message: "Une opération rapprochée ne peut pas être datée dans le futur" })
        if (current.startingBalance) return yield* new Invalid({ message: "Le solde initial ne peut pas être daté dans le futur" })

        // A transfer is planned from the side that carries its category: the budget side when the
        // other one is off budget.
        const mirror = current.transferId
          ? yield* db.use((orm) => orm.select().from(transactions).where(eq(transactions.id, current.transferId!)).get())
          : undefined
        const fromMirror =
          mirror !== undefined && patch.accountId === undefined && patch.payee === undefined && (yield* sidesOffBudget(current.accountId, mirror.accountId))
        const side = fromMirror ? mirror : current
        const amount = patch.amount === undefined ? side.amount : fromMirror ? -patch.amount : patch.amount
        const input: TxInput = {
          accountId: fromMirror ? side.accountId : (patch.accountId ?? current.accountId),
          date: patch.date!,
          amount,
          payee: fromMirror ? { kind: "transfer", accountId: current.accountId } : (patch.payee ?? (yield* payeeInputOf(current))),
          categoryId: patch.categoryId !== undefined ? patch.categoryId : side.categoryId,
          notes: patch.notes !== undefined ? patch.notes : side.notes,
        }
        const { id: scheduleId, statement } = yield* schedulesService.prepareCreate(yield* scheduleOf(input))
        yield* db.batch([statement, ...transactionsService.deleteStatements([id])])
        return { kind: "schedule", id: scheduleId, date: input.date } satisfies Recorded
      })

      /** True when `own` is off budget and `other` is not. */
      const sidesOffBudget = (own: string, other: string) =>
        db
          .use((orm) => orm.select({ id: accounts.id, offBudget: accounts.offBudget }).from(accounts))
          .pipe(
            Effect.map((rows) => {
              const offBudget = new Map(rows.map((a) => [a.id, a.offBudget]))
              return offBudget.get(own) === true && offBudget.get(other) === false
            }),
          )

      const payeeInputOf = (tx: typeof transactions.$inferSelect) =>
        tx.payeeId === null
          ? Effect.succeed<TxPayeeInput>({ kind: "none" })
          : db
              .use((orm) => orm.select().from(payees).where(eq(payees.id, tx.payeeId!)).get())
              .pipe(
                Effect.map((p): TxPayeeInput =>
                  p?.transferAccountId ? { kind: "transfer", accountId: p.transferAccountId } : { kind: "id", id: tx.payeeId! },
                ),
              )

      return Entries.of({ record, amend })
    }),
  )
}

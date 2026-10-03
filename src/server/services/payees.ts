import { eq, inArray, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { normalizeText } from "~/domain/rules"
import { bulkInsertStatements, chunkIds, Db, type DbError, newId } from "../db/client"
import { payees, rules } from "../db/schema"
import { Invalid, NotFound } from "../errors"

export type PayeeDto = {
  id: string
  name: string
  transferAccountId: string | null
  transactionCount: number
  lastCategoryId: string | null
  lastUsed: string | null
}

export class Payees extends Context.Service<
  Payees,
  {
    /** Every payee, with usage stats. Transfer payees are named after their account. */
    readonly list: Effect.Effect<PayeeDto[], DbError>
    /** Finds payees by name (case and accent insensitive) and creates the missing ones, in bulk. */
    resolveNames(names: ReadonlyArray<string>): Effect.Effect<Map<string, string>, DbError>
    rename(id: string, name: string): Effect.Effect<void, DbError | Invalid | NotFound>
    /** Points every transaction, schedule and rule of `sourceIds` at `targetId`, then deletes the sources. */
    merge(sourceIds: ReadonlyArray<string>, targetId: string): Effect.Effect<void, DbError | Invalid>
    readonly deleteUnused: Effect.Effect<number, DbError>
    /** Most used category for a payee, to pre-fill a new transaction. */
    suggestCategory(payeeId: string): Effect.Effect<string | null, DbError>
  }
>()("runway/server/services/Payees") {
  static readonly layer = Layer.effect(
    Payees,
    Effect.gen(function* () {
      const db = yield* Db

      const list = db.use(async (_, d1) => {
        const { results } = await d1
          .prepare(
            `SELECT p.id, COALESCE(a.name, p.name) AS name, p.transfer_account_id AS transferAccountId,
                    COUNT(t.id) AS transactionCount, MAX(t.date) AS lastUsed,
                    (SELECT t2.category_id FROM transactions t2
                      WHERE t2.payee_id = p.id AND t2.category_id IS NOT NULL
                      ORDER BY t2.date DESC LIMIT 1) AS lastCategoryId
             FROM payees p
             LEFT JOIN accounts a ON a.id = p.transfer_account_id
             LEFT JOIN transactions t ON t.payee_id = p.id AND t.is_parent = 0
             GROUP BY p.id
             ORDER BY p.transfer_account_id IS NOT NULL, name COLLATE NOCASE`,
          )
          .all<PayeeDto>()
        return results
      })

      const resolveNames = Effect.fn("Payees.resolveNames")(function* (names: ReadonlyArray<string>) {
        const wanted = new Map<string, string>()
        for (const raw of names) {
          const name = raw.trim()
          if (name !== "") wanted.set(normalizeText(name), name)
        }
        const result = new Map<string, string>()
        if (wanted.size === 0) return result
        // One full scan beats N lookups: payee tables stay in the low thousands.
        const existing = yield* db.use((orm) =>
          orm.select({ id: payees.id, name: payees.name }).from(payees).where(isNull(payees.transferAccountId)),
        )
        const byKey = new Map(existing.map((p) => [normalizeText(p.name), p.id]))
        const toCreate: Array<[string, string]> = []
        for (const [key, name] of wanted) {
          const found = byKey.get(key)
          if (found) result.set(name, found)
          else {
            const id = newId()
            toCreate.push([id, name])
            byKey.set(key, id)
            result.set(name, id)
          }
        }
        // Map every original spelling (not only the first one seen) to its id.
        for (const raw of names) {
          const id = byKey.get(normalizeText(raw.trim()))
          if (id) result.set(raw, id)
        }
        if (toCreate.length > 0) yield* db.batch(bulkInsertStatements(db.d1, "payees", ["id", "name"], toCreate))
        return result
      })

      const rename = Effect.fn("Payees.rename")(function* (id: string, name: string) {
        const trimmed = name.trim()
        if (trimmed === "") return yield* new Invalid({ message: "Le nom est obligatoire" })
        const payee = yield* db.use((orm) => orm.select().from(payees).where(eq(payees.id, id)).get())
        if (!payee) return yield* new NotFound({ entity: "Bénéficiaire", id })
        if (payee.transferAccountId) return yield* new Invalid({ message: "Renomme le compte plutôt que ce virement" })
        yield* db.use((orm) => orm.update(payees).set({ name: trimmed }).where(eq(payees.id, id)))
      })

      const merge = Effect.fn("Payees.merge")(function* (sourceIds: ReadonlyArray<string>, targetId: string) {
        const sources = sourceIds.filter((id) => id !== targetId)
        if (sources.length === 0) return
        const involved = yield* db.use((orm) =>
          orm
            .select()
            .from(payees)
            .where(inArray(payees.id, [...sources, targetId])),
        )
        if (involved.some((p) => p.transferAccountId)) {
          return yield* new Invalid({ message: "Les virements ne peuvent pas être fusionnés" })
        }
        yield* db.use(async (orm, d1) => {
          for (const chunk of chunkIds(sources)) {
            const marks = chunk.map(() => "?").join(",")
            await d1.batch([
              d1.prepare(`UPDATE transactions SET payee_id = ? WHERE payee_id IN (${marks})`).bind(targetId, ...chunk),
              d1.prepare(`UPDATE schedules SET payee_id = ? WHERE payee_id IN (${marks})`).bind(targetId, ...chunk),
              d1.prepare(`DELETE FROM payees WHERE id IN (${marks})`).bind(...chunk),
            ])
          }
          const allRules = await orm.select().from(rules)
          for (const rule of allRules) {
            if (!rule.actions.some((a) => a.type === "set_payee" && sources.includes(a.payeeId))) continue
            const actions = rule.actions.map((a) =>
              a.type === "set_payee" && sources.includes(a.payeeId) ? { ...a, payeeId: targetId } : a,
            )
            await orm.update(rules).set({ actions }).where(eq(rules.id, rule.id))
          }
        })
      })

      const deleteUnused = db.use(async (_, d1) => {
        const res = await d1
          .prepare(
            `DELETE FROM payees WHERE transfer_account_id IS NULL
               AND id NOT IN (SELECT payee_id FROM transactions WHERE payee_id IS NOT NULL)
               AND id NOT IN (SELECT payee_id FROM schedules WHERE payee_id IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM rules, json_each(rules.actions) a
                               WHERE json_extract(a.value, '$.payeeId') = payees.id)`,
          )
          .run()
        return res.meta.changes ?? 0
      })

      const suggestCategory = (payeeId: string) =>
        db.use(async (_, d1) => {
          const row = await d1
            .prepare(
              `SELECT category_id AS id, COUNT(*) AS n FROM (
                 SELECT category_id FROM transactions
                 WHERE payee_id = ? AND category_id IS NOT NULL AND is_parent = 0
                 ORDER BY date DESC LIMIT 10)
               GROUP BY category_id ORDER BY n DESC LIMIT 1`,
            )
            .bind(payeeId)
            .first<{ id: string }>()
          return row?.id ?? null
        })

      return Payees.of({ list, resolveNames, rename, merge, deleteUnused, suggestCategory })
    }),
  )
}

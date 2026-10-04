import { eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { normalizeText } from "~/domain/rules"
import { bulkInsertStatements, Db, type DbError, newId } from "../db/client"
import { readRule } from "../db/json-columns"
import { payees, rules } from "../db/schema"
import { Invalid, NotFound } from "../errors"
import { retargetViews } from "./saved-views"

export type PayeeNameDto = {
  id: string
  name: string
  transferAccountId: string | null
  lastCategoryId: string | null
}

export type PayeeDto = PayeeNameDto & {
  transactionCount: number
  lastUsed: string | null
}

// A payee's last category, read from the end of its (payee, date) index: a few rows per payee.
const LAST_CATEGORY = `(SELECT t2.category_id FROM transactions t2
  WHERE t2.payee_id = p.id AND t2.category_id IS NOT NULL
  ORDER BY t2.date DESC LIMIT 1)`

export class Payees extends Context.Service<
  Payees,
  {
    /** Every payee, with usage stats. Transfer payees are named after their account. */
    readonly list: Effect.Effect<PayeeDto[], DbError>
    /** Every payee without the usage counts, which read every transaction: what pickers need. */
    readonly names: Effect.Effect<PayeeNameDto[], DbError>
    /** Finds payees by name (case and accent insensitive) and creates the missing ones, in bulk. */
    resolveNames(names: ReadonlyArray<string>): Effect.Effect<Map<string, string>, DbError>
    rename(id: string, name: string): Effect.Effect<void, DbError | Invalid | NotFound>
    /** Points every transaction, schedule and rule of `sourceIds` at `targetId`, then deletes the sources. */
    merge(sourceIds: ReadonlyArray<string>, targetId: string): Effect.Effect<void, DbError | Invalid>
    readonly deleteUnused: Effect.Effect<number, DbError>
    /** Most used category for a payee, to pre-fill a new transaction. */
    suggestCategory(payeeId: string): Effect.Effect<string | null, DbError>
    suggestCategories(payeeIds: ReadonlyArray<string>): Effect.Effect<Map<string, string>, DbError>
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
                    COUNT(t.id) AS transactionCount, MAX(t.date) AS lastUsed, ${LAST_CATEGORY} AS lastCategoryId
             FROM payees p
             LEFT JOIN accounts a ON a.id = p.transfer_account_id
             LEFT JOIN transactions t ON t.payee_id = p.id AND t.is_parent = 0
             GROUP BY p.id
             ORDER BY p.transfer_account_id IS NOT NULL, name COLLATE NOCASE`,
          )
          .all<PayeeDto>()
        return results
      })

      const names = db.use(async (_, d1) => {
        const { results } = await d1
          .prepare(
            `SELECT p.id, COALESCE(a.name, p.name) AS name, p.transfer_account_id AS transferAccountId, ${LAST_CATEGORY} AS lastCategoryId
             FROM payees p
             LEFT JOIN accounts a ON a.id = p.transfer_account_id
             ORDER BY p.transfer_account_id IS NOT NULL, name COLLATE NOCASE`,
          )
          .all<PayeeNameDto>()
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
        const json = JSON.stringify([...sources, targetId])
        const transfers = yield* db.use((_, d1) =>
          d1
            .prepare("SELECT COUNT(*) AS n FROM payees WHERE transfer_account_id IS NOT NULL AND id IN (SELECT value FROM json_each(?))")
            .bind(json)
            .first<{ n: number }>(),
        )
        if ((transfers?.n ?? 0) > 0) return yield* new Invalid({ message: "Les virements ne peuvent pas être fusionnés" })
        const merged = new Set(sources)
        const allRules = (yield* db.use((orm) => orm.select().from(rules))).map(readRule)
        const ruleUpdates = allRules.flatMap((rule) =>
          rule.actions.some((a) => a.type === "set_payee" && merged.has(a.payeeId))
            ? [
                db.d1
                  .prepare("UPDATE rules SET actions = ? WHERE id = ?")
                  .bind(
                    JSON.stringify(rule.actions.map((a) => (a.type === "set_payee" && merged.has(a.payeeId) ? { ...a, payeeId: targetId } : a))),
                    rule.id,
                  ),
              ]
            : [],
        )
        const sourcesJson = JSON.stringify(sources)
        const inSources = "IN (SELECT value FROM json_each(?))"
        // Rules are rewritten in the same batch: a rule left pointing at a deleted payee would make
        // every matching transaction fail on the foreign key.
        yield* db.batch([
          db.d1.prepare(`UPDATE transactions SET payee_id = ? WHERE payee_id ${inSources}`).bind(targetId, sourcesJson),
          db.d1.prepare(`UPDATE schedules SET payee_id = ? WHERE payee_id ${inSources}`).bind(targetId, sourcesJson),
          ...ruleUpdates,
          retargetViews(db.d1, "payee", sources, { kind: "payee", id: targetId }),
          db.d1.prepare(`DELETE FROM payees WHERE id ${inSources}`).bind(sourcesJson),
        ])
      })

      const deleteUnused = db.use(async (_, d1) => {
        const res = await d1
          .prepare(
            `DELETE FROM payees WHERE transfer_account_id IS NULL
               AND id NOT IN (SELECT payee_id FROM transactions WHERE payee_id IS NOT NULL)
               AND id NOT IN (SELECT payee_id FROM schedules WHERE payee_id IS NOT NULL)
               AND id NOT IN (SELECT json_extract(a.value, '$.payeeId') FROM rules, json_each(rules.actions) a
                              WHERE json_extract(a.value, '$.payeeId') IS NOT NULL)
               AND id NOT IN (SELECT json_extract(config, '$.target.id') FROM saved_views
                              WHERE json_extract(config, '$.target.kind') = 'payee')`,
          )
          .run()
        return res.meta.changes ?? 0
      })

      // The most frequent category among each payee's last 10 categorized transactions,
      // the most recent one winning ties. One query for any number of payees.
      const suggestCategories = Effect.fn("Payees.suggestCategories")(function* (payeeIds: ReadonlyArray<string>) {
        const ids = [...new Set(payeeIds)]
        if (ids.length === 0) return new Map<string, string>()
        const rows = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `WITH recent AS (
                 SELECT payee_id, category_id, ROW_NUMBER() OVER (PARTITION BY payee_id ORDER BY date DESC, created_at DESC) AS rn
                 FROM transactions
                 WHERE payee_id IN (SELECT value FROM json_each(?)) AND category_id IS NOT NULL AND is_parent = 0
               )
               SELECT payee_id AS payeeId, category_id AS categoryId, COUNT(*) AS n, MIN(rn) AS latest
               FROM recent WHERE rn <= 10
               GROUP BY payee_id, category_id`,
            )
            .bind(JSON.stringify(ids))
            .all<{ payeeId: string; categoryId: string; n: number; latest: number }>()
          return results
        })
        const best = new Map<string, { categoryId: string; n: number; latest: number }>()
        for (const r of rows) {
          const current = best.get(r.payeeId)
          if (!current || r.n > current.n || (r.n === current.n && r.latest < current.latest)) best.set(r.payeeId, r)
        }
        return new Map([...best].map(([payeeId, r]) => [payeeId, r.categoryId]))
      })

      const suggestCategory = (payeeId: string) =>
        suggestCategories([payeeId]).pipe(Effect.map((found) => found.get(payeeId) ?? null))

      return Payees.of({ list, names, resolveNames, rename, merge, deleteUnused, suggestCategory, suggestCategories })
    }),
  )
}

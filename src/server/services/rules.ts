import { asc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { applyRules, normalizeText, type Rule, type RuleAction, type RuleCondition, type RuleSubject } from "~/domain/rules"
import { chunkIds, Db, type DbError, newId } from "../db/client"
import { rules } from "../db/schema"
import { Invalid, NotFound } from "../errors"

export type RuleDto = Rule & { origin: "manual" | "suggested" | "imported"; sortOrder: number }

export type RuleInput = {
  conditionsOp: "and" | "or"
  conditions: ReadonlyArray<RuleCondition>
  actions: ReadonlyArray<RuleAction>
  enabled?: boolean
  origin?: RuleDto["origin"]
}

export type RuleSuggestion = {
  payeeId: string
  payeeName: string
  categoryId: string
  /** Transactions of this payee that already use the category. */
  matching: number
  total: number
  /** Uncategorized transactions the rule would fix right away. */
  uncategorized: number
}

/** Why a rule cannot be saved, or null when it is valid. */
export const ruleInputError = (input: RuleInput): string | null => {
  if (input.conditions.length === 0) return "Ajoute au moins une condition"
  if (input.actions.length === 0) return "Ajoute au moins une action"
  for (const c of input.conditions) {
    if (c.op === "matches" && typeof c.value === "string") {
      try {
        new RegExp(c.value)
      } catch {
        return `Expression invalide : ${c.value}`
      }
    }
    if (typeof c.value === "string" && c.value.trim() === "" && c.field !== "account") return "Une condition est vide"
  }
  return null
}

export class Rules extends Context.Service<
  Rules,
  {
    readonly list: Effect.Effect<RuleDto[], DbError>
    create(input: RuleInput): Effect.Effect<RuleDto, DbError | Invalid>
    update(id: string, input: RuleInput): Effect.Effect<void, DbError | Invalid | NotFound>
    remove(id: string): Effect.Effect<void, DbError>
    reorder(ids: ReadonlyArray<string>): Effect.Effect<void, DbError>
    /** Returns a function applying the enabled rules, loaded once for a whole batch. */
    readonly matcher: Effect.Effect<(subject: RuleSubject) => ReturnType<typeof applyRules>, DbError>
    /** Applies one rule to existing transactions that have no category yet. Returns the count updated. */
    applyToUncategorized(id: string): Effect.Effect<number, DbError | NotFound>
    /** Payees consistently filed under the same category and not covered by a rule yet. */
    readonly suggestions: Effect.Effect<RuleSuggestion[], DbError>
  }
>()("runway/server/services/Rules") {
  static readonly layer = Layer.effect(
    Rules,
    Effect.gen(function* () {
      const db = yield* Db

      const list = db.use((orm) => orm.select().from(rules).orderBy(asc(rules.sortOrder), asc(rules.createdAt)))

      const validate = (input: RuleInput) => {
        const problem = ruleInputError(input)
        return problem ? Effect.fail(new Invalid({ message: problem })) : Effect.void
      }

      const create = Effect.fn("Rules.create")(function* (input: RuleInput) {
        yield* validate(input)
        const max = yield* db.use((orm) =>
          orm
            .select({ max: sql<number>`coalesce(max(${rules.sortOrder}), 0)` })
            .from(rules)
            .get(),
        )
        const row = {
          id: newId(),
          conditionsOp: input.conditionsOp,
          conditions: [...input.conditions],
          actions: [...input.actions],
          enabled: input.enabled ?? true,
          origin: input.origin ?? ("manual" as const),
          sortOrder: (max?.max ?? 0) + 1,
        }
        yield* db.use((orm) => orm.insert(rules).values(row))
        return row
      })

      const update = Effect.fn("Rules.update")(function* (id: string, input: RuleInput) {
        yield* validate(input)
        const found = yield* db.use((orm) => orm.select({ id: rules.id }).from(rules).where(eq(rules.id, id)).get())
        if (!found) return yield* new NotFound({ entity: "Règle", id })
        yield* db.use((orm) =>
          orm
            .update(rules)
            .set({
              conditionsOp: input.conditionsOp,
              conditions: [...input.conditions],
              actions: [...input.actions],
              ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            })
            .where(eq(rules.id, id)),
        )
      })

      const remove = (id: string) => db.use((orm) => orm.delete(rules).where(eq(rules.id, id))).pipe(Effect.asVoid)

      const reorder = (ids: ReadonlyArray<string>) =>
        db.batch(ids.map((id, i) => db.d1.prepare("UPDATE rules SET sort_order = ? WHERE id = ?").bind(i + 1, id)))

      const matcher = list.pipe(
        Effect.map((all) => {
          const enabled = all.filter((r) => r.enabled)
          return (subject: RuleSubject) => applyRules(enabled, subject)
        }),
      )

      const applyToUncategorized = Effect.fn("Rules.applyToUncategorized")(function* (id: string) {
        const rule = yield* db.use((orm) => orm.select().from(rules).where(eq(rules.id, id)).get())
        if (!rule) return yield* new NotFound({ entity: "Règle", id })
        const candidates = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `SELECT t.id, t.account_id AS accountId, t.amount, t.notes, t.imported_payee AS importedPayee,
                      p.name AS payeeName
               FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
               WHERE t.category_id IS NULL AND t.is_parent = 0 AND t.transfer_id IS NULL`,
            )
            .all<RuleSubject & { id: string }>()
          return results
        })
        const apply = (s: RuleSubject) => applyRules([{ ...rule, enabled: true }], s)
        const updates = candidates.flatMap((c) => {
          const out = apply(c)
          return out.matched.length > 0 ? [{ id: c.id, out }] : []
        })
        // Group identical outcomes so each UPDATE covers many rows.
        const groups = new Map<string, { out: (typeof updates)[number]["out"]; ids: string[] }>()
        for (const u of updates) {
          const key = JSON.stringify([u.out.categoryId, u.out.payeeId, u.out.notes])
          const g = groups.get(key) ?? { out: u.out, ids: [] }
          g.ids.push(u.id)
          groups.set(key, g)
        }
        const statements: D1PreparedStatement[] = []
        for (const { out, ids } of groups.values()) {
          for (const chunk of chunkIds(ids, 95)) {
            const marks = chunk.map(() => "?").join(",")
            statements.push(
              db.d1
                .prepare(
                  `UPDATE transactions SET
                     category_id = COALESCE(?, category_id),
                     payee_id = COALESCE(?, payee_id),
                     notes = COALESCE(?, notes)
                   WHERE id IN (${marks})`,
                )
                .bind(out.categoryId ?? null, out.payeeId ?? null, out.notes ?? null, ...chunk),
            )
          }
        }
        yield* db.batch(statements)
        return updates.length
      })

      const suggestions = Effect.gen(function* () {
        const [stats, all] = yield* Effect.all([
          db.use(async (_, d1) => {
            const { results } = await d1
              .prepare(
                `WITH u AS (
                   SELECT payee_id, COUNT(*) AS n FROM transactions
                   WHERE category_id IS NULL AND is_parent = 0 AND payee_id IS NOT NULL GROUP BY payee_id
                 )
                 SELECT t.payee_id AS payeeId, p.name AS payeeName, t.category_id AS categoryId, COUNT(*) AS n,
                        SUM(COUNT(*)) OVER (PARTITION BY t.payee_id) AS total,
                        COALESCE(MAX(u.n), 0) AS uncategorized
                 FROM transactions t JOIN payees p ON p.id = t.payee_id
                 LEFT JOIN u ON u.payee_id = t.payee_id
                 WHERE t.category_id IS NOT NULL AND t.is_parent = 0 AND p.transfer_account_id IS NULL
                 GROUP BY t.payee_id, t.category_id`,
              )
              .all<{
                payeeId: string
                payeeName: string
                categoryId: string
                n: number
                total: number
                uncategorized: number
              }>()
            return results
          }),
          list,
        ], { concurrency: "unbounded" })
        const covered = new Set<string>()
        for (const rule of all) {
          for (const c of rule.conditions) {
            if ((c.field === "payee" || c.field === "imported_payee") && typeof c.value === "string") {
              covered.add(normalizeText(c.value))
            }
          }
        }
        return stats
          .filter((s) => s.n >= 3 && s.n / s.total >= 0.9 && !covered.has(normalizeText(s.payeeName)))
          .map((s) => ({
            payeeId: s.payeeId,
            payeeName: s.payeeName,
            categoryId: s.categoryId,
            matching: s.n,
            total: s.total,
            uncategorized: s.uncategorized,
          }))
          .sort((a, b) => b.uncategorized - a.uncategorized || b.matching - a.matching)
          .slice(0, 50)
      }).pipe(Effect.withSpan("Rules.suggestions"))

      return Rules.of({ list, create, update, remove, reorder, matcher, applyToUncategorized, suggestions })
    }),
  )
}

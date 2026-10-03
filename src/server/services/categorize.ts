import { Context, Effect, Layer } from "effect"
import { formatMoney } from "~/domain/money"
import { normalizeText } from "~/domain/rules"
import { Db, type DbError } from "../db/client"
import type { ExternalError } from "../errors"
import { Ai } from "./ai"
import { Categories } from "./categories"
import { Settings } from "./settings"

export type CategorySuggestion = {
  transactionId: string
  categoryId: string
  confidence: number
  source: "jev" | "llm"
}

type Row = {
  id: string
  amount: number
  payee: string | null
  importedPayee: string | null
  notes: string | null
}

const MAX_TRANSACTIONS = 500
// One model call per distinct payee: 200 card payments at the same supermarket are one decision.
const MAX_GROUPS = 80

export class Categorizer extends Context.Service<
  Categorizer,
  {
    /**
     * Suggests a category for uncategorized transactions (the most recent ones, or the given
     * ids). Nothing is written: the user accepts suggestions through the usual updates.
     */
    suggest(ids?: ReadonlyArray<string>): Effect.Effect<{ suggestions: CategorySuggestion[]; considered: number }, DbError | ExternalError>
  }
>()("runway/server/services/Categorizer") {
  static readonly layer = Layer.effect(
    Categorizer,
    Effect.gen(function* () {
      const db = yield* Db
      const ai = yield* Ai
      const categoriesService = yield* Categories
      const settings = yield* Settings

      const suggest = Effect.fn("Categorizer.suggest")(function* (ids?: ReadonlyArray<string>) {
        const [rows, tree, startingId] = yield* Effect.all([
          db.use(async (_, d1) => {
            const idFilter = ids?.length ? `AND t.id IN (SELECT value FROM json_each(?))` : ""
            const statement = d1.prepare(
              `SELECT t.id, t.amount, p.name AS payee, t.imported_payee AS importedPayee, t.notes
               FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN payees p ON p.id = t.payee_id
               WHERE t.category_id IS NULL AND t.is_parent = 0 AND a.off_budget = 0 AND t.starting_balance = 0
                 AND p.transfer_account_id IS NULL ${idFilter}
               ORDER BY t.date DESC LIMIT ${MAX_TRANSACTIONS}`,
            )
            const { results } = await (ids?.length ? statement.bind(JSON.stringify(ids)) : statement).all<Row>()
            return results
          }),
          categoriesService.tree,
          settings.get("startingBalanceCategoryId"),
        ], { concurrency: "unbounded" })

        const groups = new Map<string, { sample: Row; ids: string[] }>()
        for (const row of rows) {
          const label = row.payee ?? row.importedPayee ?? row.notes
          if (!label) continue
          const key = `${row.amount < 0 ? "-" : "+"}${normalizeText(label)}`
          const group = groups.get(key)
          if (group) group.ids.push(row.id)
          else groups.set(key, { sample: row, ids: [row.id] })
        }
        const selected = [...groups.entries()].slice(0, MAX_GROUPS)

        const criteriaFor = (income: boolean) =>
          Object.fromEntries(
            tree
              .filter((g) => g.isIncome === income && !g.hidden)
              .flatMap((g) =>
                g.categories.filter((c) => !c.hidden && c.id !== startingId).map((c) => [c.id, `${g.name} › ${c.name}`] as const),
              ),
          ) as Record<string, string>

        const itemsFor = (income: boolean) =>
          selected
            .filter(([key]) => key.startsWith(income ? "+" : "-"))
            .map(([key, g]) => ({
              key,
              input: {
                payee: g.sample.payee,
                bank_label: g.sample.importedPayee,
                notes: g.sample.notes,
                amount: formatMoney(g.sample.amount),
                kind: income ? "income" : "expense",
              },
            }))

        const instructions =
          "Which budget category does this bank transaction belong to? The data comes from a French personal budget."
        // One after the other: each call already uses the 6 connections a Worker may open at once,
        // and queued requests would spend their timeout waiting.
        const [expenses, income] = yield* Effect.all([
          ai.classify({ instructions, criteria: criteriaFor(false), items: itemsFor(false) }),
          ai.classify({ instructions, criteria: criteriaFor(true), items: itemsFor(true) }),
        ])

        const suggestions: CategorySuggestion[] = []
        for (const [key, group] of selected) {
          const answer = expenses.get(key) ?? income.get(key)
          if (!answer) continue
          for (const transactionId of group.ids) {
            suggestions.push({ transactionId, categoryId: answer.label, confidence: answer.confidence, source: answer.source })
          }
        }
        return { suggestions, considered: rows.length }
      })

      return Categorizer.of({ suggest })
    }),
  )
}

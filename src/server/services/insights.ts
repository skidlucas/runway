import { asc } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { addMonths, type Day, diffDays, lastDay, type Month, monthRange, parseDay } from "~/domain/dates"
import {
  type CategoryInsightInput,
  computeFindings,
  EARLY_MONTH_DAYS,
  computeView,
  type Finding,
  INSIGHT_MEASURES,
  INSIGHT_MONTHS,
  INSIGHT_ROLLING,
  INSIGHT_TARGET_KINDS,
  type InsightView,
  type MonthTotals,
  type NewRecurring,
  type PayeeTotal,
} from "~/domain/insights"
import { Db, type DbError, newId } from "../db/client"
import { BUDGET_LINE, COUNTS_FOR_BUDGET } from "../db/predicates"
import { dashboards, type InsightViewConfig, savedViews } from "../db/schema"
import { type ExternalError, Invalid, NotFound } from "../errors"
import { normalizeText } from "~/domain/rules"
import { Ai } from "./ai"
import { Categories } from "./categories"
import { Schedules } from "./schedules"
import { Settings } from "./settings"

export type InsightQuery = InsightViewConfig

type BreakdownRow = { id: string | null; name: string; amount: number; count: number }

export type InsightViewDto = InsightView & {
  query: InsightQuery
  month: Month
  today: Day
  label: string
  breakdown: { by: "payee" | "category"; rows: BreakdownRow[] }
}

export type FindingsDto = { month: Month; today: Day; findings: Finding[] }

export type SavedViewDto = { id: string; name: string; config: InsightViewConfig }

const AnalysisSchema = Schema.Struct({
  headline: Schema.String,
  points: Schema.Array(
    Schema.Struct({
      tone: Schema.Literals(["positive", "negative", "neutral"]),
      title: Schema.String,
      detail: Schema.String,
    }),
  ),
})
export type AiAnalysis = typeof AnalysisSchema.Type & { month: Month }

const InterpretationSchema = Schema.Struct({
  understood: Schema.Boolean,
  measure: Schema.Literals(INSIGHT_MEASURES),
  targetKind: Schema.Literals(["all", ...INSIGHT_TARGET_KINDS]),
  targetName: Schema.NullOr(Schema.String),
  months: Schema.Literals(INSIGHT_MONTHS),
  rolling: Schema.Literals(INSIGHT_ROLLING),
})
export type Interpretation = { query: InsightQuery | null; message: string | null }

// Shared SQL fragments. Amounts are flipped for expenses so every total is positive.
// Uncategorized lines count towards "all expenses" / "all income" by their sign.
const BASE_FROM = `FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN payees p ON p.id = t.payee_id`

const measureSql = (measure: InsightQuery["measure"]) =>
  measure === "income"
    ? { sign: "t.amount", where: "(c.is_income = 1 OR (t.category_id IS NULL AND t.amount > 0))" }
    : { sign: "-t.amount", where: "(c.is_income = 0 OR (t.category_id IS NULL AND t.amount < 0))" }

const targetSql = (target: InsightQuery["target"]): { where: string; params: string[] } => {
  switch (target.kind) {
    case "all":
      return { where: "1 = 1", params: [] }
    case "category":
      return { where: "t.category_id = ?", params: [target.id] }
    case "group":
      return { where: "c.group_id = ?", params: [target.id] }
    case "payee":
      return { where: "t.payee_id = ?", params: [target.id] }
  }
}

const COMMON_WHERE = `${COUNTS_FOR_BUDGET} AND t.starting_balance = 0`

export class Insights extends Context.Service<
  Insights,
  {
    view(query: InsightQuery): Effect.Effect<InsightViewDto, DbError | Invalid | NotFound>
    readonly findings: Effect.Effect<FindingsDto, DbError | Invalid | NotFound>
    /** AI commentary on the month; every figure it sees is computed here, not by the model. */
    readonly analysis: Effect.Effect<AiAnalysis, DbError | Invalid | NotFound | ExternalError>
    /** Turns a question ("restos sur 6 mois ?") into a query; numbers then come from `view`. */
    interpret(question: string): Effect.Effect<Interpretation, DbError | ExternalError>
    readonly savedViews: Effect.Effect<SavedViewDto[], DbError>
    saveView(name: string, config: InsightViewConfig): Effect.Effect<SavedViewDto, DbError | Invalid>
    deleteView(id: string): Effect.Effect<void, DbError>
  }
>()("runway/server/services/Insights") {
  static readonly layer = Layer.effect(
    Insights,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings
      const categoriesService = yield* Categories
      const schedules = yield* Schedules
      const ai = yield* Ai

      const validate = (query: InsightQuery) =>
        !INSIGHT_MONTHS.includes(query.months) || !INSIGHT_ROLLING.includes(query.rolling)
          ? Effect.fail(new Invalid({ message: "Période ou moyenne invalide" }))
          : Effect.void

      // Deletions and merges retarget saved views; a view restored from an older backup may still
      // point at something gone, and then shows empty figures under this label.
      const MISSING_TARGET = { category: "Catégorie supprimée", group: "Groupe supprimé", payee: "Bénéficiaire supprimé" } as const

      const targetLabel = (query: InsightQuery) => {
        const { target, measure } = query
        if (target.kind === "all") return Effect.succeed(measure === "income" ? "Tous les revenus" : "Toutes les dépenses")
        const table = target.kind === "category" ? "categories" : target.kind === "group" ? "category_groups" : "payees"
        return db
          .use((_, d1) => d1.prepare(`SELECT name FROM ${table} WHERE id = ?`).bind(target.id).first<{ name: string }>())
          .pipe(Effect.map((row) => row?.name ?? MISSING_TARGET[target.kind]))
      }

      // What the budget engine reports as budgeted: the budget rows of expense categories (it
      // reads income categories as never budgeted).
      const budgetedIn = (month: Month, target: Exclude<InsightQuery["target"], { kind: "payee" }>) =>
        db
          .use((_, d1) =>
            d1
              .prepare(
                `SELECT COALESCE(SUM(b.amount), 0) AS amount FROM budgets b
                 JOIN categories c ON c.id = b.category_id JOIN category_groups g ON g.id = c.group_id
                 WHERE b.month = ? AND c.is_income = 0
                   AND ${target.kind === "category" ? "c.id = ?" : target.kind === "group" ? "g.is_income = 0 AND g.id = ?" : "g.is_income = 0"}`,
              )
              .bind(month, ...(target.kind === "all" ? [] : [target.id]))
              .first<{ amount: number }>(),
          )
          .pipe(Effect.map((row) => row?.amount ?? 0))

      const view = Effect.fn("Insights.view")(function* (query: InsightQuery) {
        yield* validate(query)
        const today = yield* settings.today
        const month = today.slice(0, 7)
        const first = addMonths(month, -(query.months + query.rolling - 1))
        const months = monthRange(first, month)
        const periodStart = `${addMonths(month, -(query.months - 1))}-01`
        const measure = measureSql(query.measure)
        const target = targetSql(query.target)
        const dayOfMonth = parseDay(today).d
        const breakdownBy = query.target.kind === "payee" ? "category" : "payee"

        const [label, raw, budgetAmount] = yield* Effect.all([
          targetLabel(query),
          db.use(async (_, d1) => {
            const [series, breakdown] = await d1.batch([
              d1
                .prepare(
                  `SELECT substr(t.date, 1, 7) AS month, SUM(${measure.sign}) AS total,
                     SUM(CASE WHEN CAST(substr(t.date, 9, 2) AS INTEGER) <= ? THEN ${measure.sign} ELSE 0 END) AS toDate,
                     COUNT(*) AS count
                   ${BASE_FROM}
                   WHERE ${COMMON_WHERE} AND t.date BETWEEN ? AND ? AND ${measure.where} AND ${target.where}
                   GROUP BY month`,
                )
                .bind(dayOfMonth, `${first}-01`, lastDay(month), ...target.params),
              d1
                .prepare(
                  breakdownBy === "payee"
                    ? `SELECT t.payee_id AS id, COALESCE(p.name, 'Sans bénéficiaire') AS name,
                         SUM(${measure.sign}) AS amount, COUNT(*) AS count
                       ${BASE_FROM}
                       WHERE ${COMMON_WHERE} AND t.date BETWEEN ? AND ? AND ${measure.where} AND ${target.where}
                       GROUP BY t.payee_id ORDER BY amount DESC LIMIT 8`
                    : `SELECT t.category_id AS id, COALESCE(c.name, 'Non catégorisé') AS name,
                         SUM(${measure.sign}) AS amount, COUNT(*) AS count
                       ${BASE_FROM}
                       WHERE ${COMMON_WHERE} AND t.date BETWEEN ? AND ? AND ${measure.where} AND ${target.where}
                       GROUP BY t.category_id ORDER BY amount DESC LIMIT 8`,
                )
                .bind(periodStart, lastDay(month), ...target.params),
            ])
            return {
              series: (series?.results ?? []) as Array<{ month: string; total: number; toDate: number; count: number }>,
              breakdown: (breakdown?.results ?? []) as BreakdownRow[],
            }
          }),
          query.measure === "expenses" && query.target.kind !== "payee" ? budgetedIn(month, query.target) : Effect.succeed(null),
        ], { concurrency: "unbounded" })

        const byMonth = new Map(raw.series.map((r) => [r.month, r]))
        const totals: MonthTotals[] = months.map((m) => {
          const r = byMonth.get(m)
          return { month: m, total: r?.total ?? 0, toDate: r?.toDate ?? 0, count: r?.count ?? 0 }
        })
        const result = computeView({ totals, months: query.months, rolling: query.rolling, today, budget: budgetAmount || null })
        return {
          ...result,
          query,
          month,
          today,
          label,
          breakdown: { by: breakdownBy, rows: raw.breakdown.filter((r) => r.amount > 0) },
        } satisfies InsightViewDto
      })

      const monthData = Effect.gen(function* () {
        const today = yield* settings.today
        const month = today.slice(0, 7)
        const first = addMonths(month, -12)
        const months = monthRange(first, month)
        const expense = measureSql("expenses")
        const dayOfMonth = parseDay(today).d

        const [raw, tree, suggestions] = yield* Effect.all([
          db.use(async (_, d1) => {
            const [series, payeesByCategory, topPayees, monthTotal, budgets, income] = await d1.batch([
              d1
                .prepare(
                  `SELECT substr(t.date, 1, 7) AS month, t.category_id AS categoryId, SUM(-t.amount) AS total,
                     SUM(CASE WHEN CAST(substr(t.date, 9, 2) AS INTEGER) <= ? THEN -t.amount ELSE 0 END) AS toDate,
                     COUNT(*) AS count
                   ${BASE_FROM}
                   WHERE ${COMMON_WHERE} AND c.is_income = 0 AND t.date BETWEEN ? AND ?
                   GROUP BY month, t.category_id`,
                )
                .bind(dayOfMonth, `${first}-01`, lastDay(month)),
              d1
                .prepare(
                  `SELECT t.category_id AS categoryId, COALESCE(p.name, 'Sans bénéficiaire') AS name, SUM(-t.amount) AS amount
                   ${BASE_FROM}
                   WHERE ${COMMON_WHERE} AND c.is_income = 0 AND t.date BETWEEN ? AND ?
                   GROUP BY t.category_id, t.payee_id`,
                )
                .bind(`${month}-01`, lastDay(month)),
              d1
                .prepare(
                  `SELECT t.payee_id AS id, p.name AS name, SUM(-t.amount) AS amount, COUNT(*) AS count
                   ${BASE_FROM}
                   WHERE ${COMMON_WHERE} AND t.payee_id IS NOT NULL AND p.transfer_account_id IS NULL
                     AND t.date BETWEEN ? AND ? AND ${expense.where}
                   GROUP BY t.payee_id ORDER BY amount DESC LIMIT 5`,
                )
                .bind(`${month}-01`, lastDay(month)),
              d1
                .prepare(
                  `SELECT COALESCE(SUM(-t.amount), 0) AS total ${BASE_FROM}
                   WHERE ${COMMON_WHERE} AND t.date BETWEEN ? AND ? AND ${expense.where}`,
                )
                .bind(`${month}-01`, lastDay(month)),
              d1.prepare("SELECT month, category_id AS categoryId, amount FROM budgets WHERE month BETWEEN ? AND ?").bind(first, month),
              // The budget's income: what its income categories received this month.
              d1
                .prepare(
                  `SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t
                   JOIN accounts a ON a.id = t.account_id JOIN categories c ON c.id = t.category_id
                   WHERE ${BUDGET_LINE} AND c.is_income = 1 AND t.date BETWEEN ? AND ?`,
                )
                .bind(`${month}-01`, lastDay(month)),
            ])
            return {
              series: (series?.results ?? []) as Array<{ month: string; categoryId: string; total: number; toDate: number; count: number }>,
              payeesByCategory: (payeesByCategory?.results ?? []) as Array<{ categoryId: string; name: string; amount: number }>,
              topPayees: (topPayees?.results ?? []) as PayeeTotal[],
              monthTotal: ((monthTotal?.results?.[0] as { total: number } | undefined)?.total ?? 0) as number,
              budgets: (budgets?.results ?? []) as Array<{ month: Month; categoryId: string; amount: number }>,
              income: ((income?.results?.[0] as { total: number } | undefined)?.total ?? 0) as number,
            }
          }),
          categoriesService.tree,
          schedules.suggestions,
        ], { concurrency: "unbounded" })

        const series = new Map<string, Map<Month, (typeof raw.series)[number]>>()
        for (const r of raw.series) {
          const m = series.get(r.categoryId) ?? new Map()
          m.set(r.month, r)
          series.set(r.categoryId, m)
        }
        const topPayee = new Map<string, { name: string; amount: number }>()
        for (const r of raw.payeesByCategory) {
          const current = topPayee.get(r.categoryId)
          if (!current || r.amount > current.amount) topPayee.set(r.categoryId, { name: r.name, amount: r.amount })
        }

        const budgeted = new Map(raw.budgets.map((b) => [`${b.month}|${b.categoryId}`, b.amount]))
        // Income categories are never budgeted, as in the budget engine.
        const budgetedOf = (m: Month, c: { id: string; isIncome: boolean }) => (c.isIncome ? 0 : (budgeted.get(`${m}|${c.id}`) ?? 0))

        const categories: CategoryInsightInput[] = tree
          .filter((g) => !g.isIncome)
          .flatMap((g) => g.categories)
          .filter((c) => series.has(c.id) || budgetedOf(month, c) > 0)
          .map((c) => {
            const rows = series.get(c.id)
            return {
              id: c.id,
              name: c.name,
              budgeted: budgetedOf(month, c),
              topPayee: topPayee.get(c.id) ?? null,
              history: months.map((m) => {
                const r = rows?.get(m)
                return {
                  month: m,
                  total: r?.total ?? 0,
                  toDate: r?.toDate ?? 0,
                  count: r?.count ?? 0,
                  budgeted: budgetedOf(m, c),
                }
              }),
            }
          })

        // "New" = the series started within the last ~3 months, so it is not yet a habit.
        const newRecurring: NewRecurring[] = suggestions
          .filter((s) => s.amount < 0 && diffDays(s.firstDate, today) <= 100)
          .map((s) => ({
            payeeId: s.payeeId,
            payeeName: s.payeeName,
            amount: s.amount,
            lastDate: s.lastDate,
            categoryName: s.categoryName,
          }))

        return {
          month,
          today,
          categories,
          topPayees: raw.topPayees.filter((p) => p.amount > 0),
          monthTotal: raw.monthTotal,
          newRecurring,
          income: raw.income,
        }
      })

      const findings = monthData.pipe(
        Effect.map(
          (d): FindingsDto => ({
            month: d.month,
            today: d.today,
            findings: computeFindings({
              today: d.today,
              categories: d.categories,
              topPayees: d.topPayees,
              monthTotal: d.monthTotal,
              newRecurring: d.newRecurring,
            }),
          }),
        ),
        Effect.withSpan("Insights.findings"),
      )

      const analysis = Effect.gen(function* () {
        const d = yield* monthData
        const local = computeFindings({ ...d })
        const euros = (cents: number) => Math.round(cents) / 100
        const dayOfMonth = parseDay(d.today).d
        // Too early in the month for the current figures to mean anything: the model is
        // pointed at last month's review and the 6-month trends instead.
        const earlyInMonth = dayOfMonth <= EARLY_MONTH_DAYS
        const facts = {
          today: d.today,
          dayOfMonth,
          focus: earlyInMonth ? "previous_month_review_and_trends" : "current_month",
          incomeThisMonth: euros(d.income),
          spentThisMonth: euros(d.monthTotal),
          categories: d.categories
            .map((c) => {
              const past = c.history.slice(-7, -1)
              const last = past[past.length - 1]
              const soFar = c.history[c.history.length - 1]?.toDate ?? 0
              const sameDay = last?.toDate ?? 0
              return {
                name: c.name,
                budgetThisMonth: euros(c.budgeted),
                ...(soFar > 0 || sameDay > 0
                  ? { spentSoFar: euros(soFar), spentSameDayLastMonth: euros(sameDay), changeVsSameDayLastMonth: euros(soFar - sameDay) }
                  : {}),
                lastMonth: last ? { month: last.month, spent: euros(last.total), budget: euros(last.budgeted) } : null,
                average6Months: euros(past.reduce((sum, h) => sum + h.total, 0) / Math.max(1, past.length)),
                last6Months: past.map((h) => ({ month: h.month, spent: euros(h.total), budget: euros(h.budgeted) })),
              }
            })
            .filter((c) => c.last6Months.some((m) => m.spent > 0) || "spentSoFar" in c),
          topPayeesThisMonth: d.topPayees.map((p) => ({ name: p.name, spent: euros(p.amount), count: p.count })),
          alreadyShown: local.map((f) => f.text),
        }
        const result = yield* ai.generate({
          schema: AnalysisSchema,
          objectName: "budget_analysis",
          system: [
            "Tu es l'assistant d'une app de budget personnel par enveloppes (comme YNAB ou Actual).",
            "Tu reçois des chiffres déjà calculés, en euros. N'invente aucun chiffre et ne fais pas de calcul hasardeux : cite seulement ceux fournis ou des écarts évidents.",
            "Réponds en français, en tutoyant, ton factuel et bref.",
            "Si focus = previous_month_review_and_trends (début de mois) : headline = bilan du mois précédent (lastMonth) ; points = écarts du mois précédent au budget, tendances sur 6 mois, budgets à ajuster pour le mois qui commence. Ne commente pas les montants du mois en cours.",
            "Si focus = current_month : headline = synthèse du mois en cours ; compare-le à la même date du mois précédent (changeVsSameDayLastMonth, positif = plus dépensé), pas au mois entier.",
            "points : 3 à 5 observations utiles et actionnables (tendance, dérive, habitude, budget à ajuster), différentes de celles listées dans alreadyShown. Jamais une observation du type « X est encore à 0 € ».",
            "title : une phrase courte (moins de 120 caractères). detail : une ligne de contexte avec les chiffres qui la justifient.",
            "tone : positive seulement si c'est une bonne nouvelle (moins dépensé, marge sur le budget), negative pour une dérive ou un dépassement, neutral sinon. Vérifie que le titre et le ton disent la même chose que les chiffres.",
          ].join("\n"),
          prompt: JSON.stringify(facts),
        })
        return { ...result, month: d.month } satisfies AiAnalysis
      }).pipe(Effect.withSpan("Insights.analysis"))

      const interpret = Effect.fn("Insights.interpret")(function* (question: string) {
        const trimmed = question.trim().slice(0, 300)
        if (!trimmed) return { query: null, message: "Pose une question" } satisfies Interpretation
        const names = yield* db.use(async (_, d1) => {
          const [cats, groups, payees] = await d1.batch([
            d1.prepare(
              `SELECT c.id, c.name, g.name AS groupName, c.is_income AS isIncome FROM categories c
               JOIN category_groups g ON g.id = c.group_id WHERE c.hidden = 0`,
            ),
            d1.prepare("SELECT id, name, is_income AS isIncome FROM category_groups WHERE hidden = 0"),
            d1.prepare(
              `SELECT p.id, p.name FROM payees p JOIN transactions t ON t.payee_id = p.id
               WHERE p.transfer_account_id IS NULL GROUP BY p.id ORDER BY COUNT(*) DESC LIMIT 300`,
            ),
          ])
          return {
            categories: (cats?.results ?? []) as Array<{ id: string; name: string; groupName: string; isIncome: number }>,
            groups: (groups?.results ?? []) as Array<{ id: string; name: string; isIncome: number }>,
            payees: (payees?.results ?? []) as Array<{ id: string; name: string }>,
          }
        })
        const answer = yield* ai.generate({
          schema: InterpretationSchema,
          objectName: "insight_query",
          system: [
            "Traduis la question de l'utilisateur sur son budget en filtres pour un graphique.",
            "measure : expenses (dépenses) ou income (revenus). targetKind : all, category, group (groupe de catégories) ou payee (bénéficiaire, commerçant).",
            "targetName : copie exacte d'un nom des listes fournies, ou null si targetKind = all.",
            "months : période affichée (3, 6, 12 ou 24 mois ; 12 par défaut, « cette année » = 12). rolling : moyenne glissante (0, 3, 6 ou 12 ; 6 par défaut si la question parle de moyenne, sinon 3).",
            "understood = false si la question ne porte pas sur des dépenses ou revenus.",
          ].join("\n"),
          prompt: JSON.stringify({
            question: trimmed,
            categories: names.categories.map((c) => `${c.name} (groupe ${c.groupName}${c.isIncome ? ", revenus" : ""})`),
            groups: names.groups.map((g) => g.name),
            payees: names.payees.map((p) => p.name),
          }),
        })
        if (!answer.understood) {
          return { query: null, message: "Je n'ai pas compris la question. Essaie « restaurants sur 6 mois »." } satisfies Interpretation
        }
        let target: InsightQuery["target"] = { kind: "all" }
        if (answer.targetKind !== "all" && answer.targetName) {
          const wanted = normalizeText(answer.targetName)
          const pool =
            answer.targetKind === "category" ? names.categories : answer.targetKind === "group" ? names.groups : names.payees
          const found =
            pool.find((item) => normalizeText(item.name) === wanted) ??
            pool.find((item) => normalizeText(item.name).includes(wanted) || wanted.includes(normalizeText(item.name)))
          if (!found) return { query: null, message: `Je ne trouve pas « ${answer.targetName} ».` } satisfies Interpretation
          target = { kind: answer.targetKind, id: found.id }
        }
        return {
          query: { measure: answer.measure, target, months: answer.months, rolling: answer.rolling },
          message: null,
        } satisfies Interpretation
      })

      const listViews = db
        .use((orm) => orm.select().from(savedViews).orderBy(asc(savedViews.sortOrder), asc(savedViews.name)))
        .pipe(Effect.map((rows) => rows.map((r) => ({ id: r.id, name: r.name, config: r.config }))))

      const saveView = Effect.fn("Insights.saveView")(function* (name: string, config: InsightViewConfig) {
        const trimmed = name.trim()
        if (!trimmed) return yield* new Invalid({ message: "Donne un nom à la vue" })
        yield* validate(config)
        const id = newId()
        const now = yield* Clock.currentTimeMillis
        yield* db.use((orm) => orm.insert(savedViews).values({ id, name: trimmed, config, sortOrder: now }))
        return { id, name: trimmed, config }
      })

      const deleteView = Effect.fn("Insights.deleteView")(function* (id: string) {
        const boards = yield* db.use((orm) => orm.select().from(dashboards))
        const showing = boards.filter((b) => b.widgets.some((w) => w.viewId === id))
        yield* db.batch([
          ...showing.map((b) =>
            db.d1
              .prepare("UPDATE dashboards SET widgets = ? WHERE id = ?")
              .bind(JSON.stringify(b.widgets.filter((w) => w.viewId !== id)), b.id),
          ),
          db.d1.prepare("DELETE FROM saved_views WHERE id = ?").bind(id),
        ])
      })

      return Insights.of({ view, findings, analysis, interpret, savedViews: listViews, saveView, deleteView })
    }),
  )
}

import { addDays, addMonths, type Day, daysInMonth, formatDayShort, formatMonthName, type Month, monthOf, parseDay } from "./dates"
import { formatMoney } from "./money"
import { count } from "./text"

// Everything here works on positive "measured" amounts in cents: money spent for the
// expense measure, money received for the income measure. Refunds lower the total.

export type MonthTotals = {
  readonly month: Month
  /** Whole month (or month to date for the current month). */
  readonly total: number
  /** Up to the same day of month as today, used for like-for-like comparisons. */
  readonly toDate: number
  readonly count: number
}

const sum = (values: ReadonlyArray<number>) => values.reduce((s, v) => s + v, 0)
const mean = (values: ReadonlyArray<number>) => (values.length ? sum(values) / values.length : 0)

/**
 * Average of the `window` complete months before `index` (the month at `index` itself is
 * excluded, so the current, partial month never drags the average down).
 */
export const trailingAverage = (
  values: ReadonlyArray<number>,
  index: number,
  window: number,
  firstDataIndex = 0,
): number | null => {
  // Months before the first data point are "no history", not zero spending: the
  // window shrinks to what exists instead of averaging in phantom zeros.
  const start = Math.max(index - window, firstDataIndex)
  if (window <= 0 || index - window < 0 || start >= index) return null
  return Math.round(mean(values.slice(start, index)))
}

/**
 * End-of-month projection for a partial month. When past months are known, the rest of
 * the month is expected to follow their average "rest of month" (total minus what had been
 * spent by the same day), which handles fixed charges paid early in the month (rent on the
 * 3rd would make a linear projection explode). Without history it falls back to a linear
 * pace over the elapsed days.
 */
export const projectMonthEnd = (
  current: { readonly toDate: number },
  history: ReadonlyArray<Pick<MonthTotals, "total" | "toDate">>,
  today: Day,
): number => {
  const month = monthOf(today)
  const elapsed = parseDay(today).d
  const length = daysInMonth(month)
  if (elapsed >= length) return current.toDate
  if (history.length > 0) {
    const rest = mean(history.map((h) => Math.max(0, h.total - h.toDate)))
    return Math.round(current.toDate + rest)
  }
  return Math.round((current.toDate / elapsed) * length)
}

/** Day when cumulative spending reaches `budget`, assuming the projected rest is spread evenly. */
export const projectedOverrunDay = (spent: number, projected: number, budget: number, today: Day): Day | null => {
  if (budget <= 0 || projected <= budget) return null
  if (spent >= budget) return today
  const length = daysInMonth(monthOf(today))
  const remainingDays = length - parseDay(today).d
  if (remainingDays <= 0) return null
  const perDay = (projected - spent) / remainingDays
  return addDays(today, Math.max(1, Math.ceil((budget - spent) / perDay)))
}

// --- View (query bar + chart) --------------------------------------------------------

export const INSIGHT_MEASURES = ["expenses", "income"] as const
export type InsightMeasure = (typeof INSIGHT_MEASURES)[number]
export const INSIGHT_TARGET_KINDS = ["category", "group", "payee"] as const
export type InsightTargetKind = (typeof INSIGHT_TARGET_KINDS)[number]
/** Months shown by a view. */
export const INSIGHT_MONTHS = [3, 6, 12, 24] as const
export type InsightMonths = (typeof INSIGHT_MONTHS)[number]
/** Length of the rolling average, 0 for none. */
export const INSIGHT_ROLLING = [0, 3, 6, 12] as const
export type InsightRolling = (typeof INSIGHT_ROLLING)[number]

type InsightBar = { readonly month: Month; readonly value: number; readonly average: number | null; readonly current: boolean }

export type InsightView = {
  readonly bars: ReadonlyArray<InsightBar>
  readonly current: number
  /** Trailing average of the complete months before the current one, null when disabled. */
  readonly average: number | null
  readonly projection: number
  readonly budget: number | null
  /** Projection above the budget (or above the average when there is no budget). */
  readonly projectionAlert: boolean
  readonly periodTotal: number
  readonly periodAverage: number
}

/**
 * `totals` must cover the `months` visible months plus `rolling` months before them,
 * oldest first, ending with the current month.
 */
export const computeView = (input: {
  readonly totals: ReadonlyArray<MonthTotals>
  readonly months: number
  readonly rolling: number
  readonly today: Day
  readonly budget: number | null
}): InsightView => {
  const { totals, months, rolling, today, budget } = input
  const values = totals.map((t) => t.total)
  const start = Math.max(0, totals.length - months)
  const currentMonth = monthOf(today)
  const found = totals.findIndex((t) => t.count > 0)
  const firstData = found < 0 ? totals.length : found
  const bars = totals.slice(start).map((t, i) => {
    const index = start + i
    return {
      month: t.month,
      value: t.total,
      average:
        rolling > 0 && index >= firstData
          ? trailingAverage(values, t.month === currentMonth ? index : index + 1, rolling, firstData)
          : null,
      current: t.month === currentMonth,
    }
  })
  const last = totals[totals.length - 1]
  const current = last?.month === currentMonth ? last.total : 0
  // Months before the first transaction are not "months with nothing spent": counting them would
  // pull the projection and the average towards zero for a category that just started.
  const history = totals.slice(Math.max(firstData, totals.length - 1 - Math.max(rolling, 3)), totals.length - 1)
  const average = rolling > 0 ? trailingAverage(values, totals.length - 1, rolling, firstData) : null
  const projection = last?.month === currentMonth ? projectMonthEnd(last, history, today) : current
  const reference = budget && budget > 0 ? budget : average
  const complete = bars.filter((b) => !b.current)
  return {
    bars,
    current,
    average,
    projection,
    budget,
    projectionAlert: reference !== null && reference > 0 && projection > reference * 1.02,
    periodTotal: sum(bars.map((b) => b.value)),
    periodAverage: Math.round(mean(complete.map((b) => b.value))),
  }
}

// --- Findings ("Constats du mois") ---------------------------------------------------

export type CategoryInsightInput = {
  readonly id: string
  readonly name: string
  /** Budgeted for the current month, 0 when nothing is budgeted. */
  readonly budgeted: number
  /** Oldest first, the last entry is the current month. */
  readonly history: ReadonlyArray<MonthTotals & { readonly budgeted: number }>
  /** Biggest payee of the current month for this category. */
  readonly topPayee: { readonly name: string; readonly amount: number } | null
}

export type PayeeTotal = { readonly id: string; readonly name: string; readonly amount: number; readonly count: number }

export type NewRecurring = {
  readonly payeeId: string
  readonly payeeName: string
  readonly amount: number
  readonly lastDate: Day
  readonly categoryName: string | null
}

export type FindingTone = "negative" | "positive" | "warning" | "accent"

export type Finding = {
  readonly kind: "projection" | "below_last_month" | "new_recurring" | "top_payees" | "overspent_streak"
  readonly tone: FindingTone
  readonly text: string
  readonly context: string
  readonly categoryId?: string
  readonly payeeId?: string
}

const pct = (ratio: number) => `${Math.round(Math.abs(ratio) * 100)} %`
const euros = (cents: number) => formatMoney(cents, { decimals: cents % 100 === 0 || Math.abs(cents) >= 100_000 ? 0 : 2 })

const projectionFinding = (c: CategoryInsightInput, today: Day): (Finding & { weight: number }) | null => {
  const current = c.history[c.history.length - 1]
  if (!current || current.toDate <= 0) return null
  const past = c.history.slice(0, -1)
  const firstData = past.findIndex((h) => h.count > 0)
  const recent = firstData < 0 ? [] : past.slice(Math.max(firstData, past.length - 6))
  const projection = projectMonthEnd(current, recent, today)
  const average6 = recent.length >= 3 ? Math.round(mean(recent.map((h) => h.total))) : null
  const overBudget = c.budgeted > 0 && projection > c.budgeted * 1.05 && projection - c.budgeted >= 1000
  const overAverage = average6 !== null && average6 > 0 && projection > average6 * 1.15 && projection - average6 >= 2000
  // With a budget, the budget is the reference: spending above habits but within budget is fine.
  if (c.budgeted > 0 ? !overBudget : !overAverage) return null
  const monthName = formatMonthName(monthOf(today))
  const comparison =
    average6 !== null && average6 > 0 && projection > average6
      ? `, ${pct(projection / average6 - 1)} au-dessus de ta moyenne 6 mois`
      : c.budgeted > 0
        ? `, ${pct(projection / c.budgeted - 1)} au-dessus du budget`
        : ""
  const overrun = projectedOverrunDay(current.toDate, projection, c.budgeted, today)
  const context =
    c.budgeted > 0
      ? current.toDate >= c.budgeted
        ? `Budget ${euros(c.budgeted)} · déjà dépassé de ${euros(current.toDate - c.budgeted)}`
        : `Budget ${euros(c.budgeted)}${overrun ? ` · dépassement probable le ${formatDayShort(overrun)}` : ""}`
      : `Pas de budget · moyenne 6 mois ${euros(average6 ?? 0)}`
  return {
    kind: "projection",
    tone: "negative",
    text: `${c.name} : au rythme actuel, ${euros(projection)} fin ${monthName}${comparison}.`,
    context,
    categoryId: c.id,
    weight: projection - (c.budgeted > 0 ? c.budgeted : (average6 ?? 0)),
  }
}

const belowLastMonthFinding = (c: CategoryInsightInput, today: Day): (Finding & { weight: number }) | null => {
  const current = c.history[c.history.length - 1]
  const previous = c.history[c.history.length - 2]
  if (!current || !previous || previous.toDate < 5000) return null
  const delta = current.toDate - previous.toDate
  if (delta > -2000 || current.toDate > previous.toDate * 0.9) return null
  const topPayeeFraction = c.topPayee && current.toDate > 0 ? c.topPayee.amount / current.toDate : 0
  return {
    kind: "below_last_month",
    tone: "positive",
    text: `${c.name} : ${euros(current.toDate)} dépensés, ${pct(delta / previous.toDate)} de moins qu'à la même date en ${formatMonthName(addMonths(monthOf(today), -1))}.`,
    context:
      c.topPayee && topPayeeFraction >= 0.3
        ? `${c.topPayee.name} représente ${pct(topPayeeFraction)} du poste`
        : `${euros(previous.toDate)} au ${parseDay(today).d} ${formatMonthName(addMonths(monthOf(today), -1))}`,
    categoryId: c.id,
    weight: -delta,
  }
}

const streakFinding = (c: CategoryInsightInput): (Finding & { weight: number }) | null => {
  const months = c.history
  const current = months[months.length - 1]
  if (!current) return null
  const overspent = (m: (typeof months)[number]) => m.budgeted > 0 && m.total > m.budgeted * 1.05 && m.total - m.budgeted >= 500
  let streak = 0
  for (let i = months.length - 2; i >= 0; i--) {
    const m = months[i]
    if (!m || !overspent(m)) break
    streak++
  }
  if (streak < 2) return null
  const ongoing = overspent(current)
  const last12 = months.slice(-13, -1)
  const average = Math.round(mean(last12.map((m) => m.total)))
  const budget = c.budgeted > 0 ? c.budgeted : (months[months.length - 2]?.budgeted ?? 0)
  return {
    kind: "overspent_streak",
    tone: "negative",
    text: ongoing
      ? `${c.name} dépasse son budget pour le ${streak + 1}e mois consécutif.`
      : `${c.name} a dépassé son budget ${streak} mois de suite.`,
    context: `Moyenne ${last12.length} mois : ${euros(average)} pour ${euros(budget)} budgétés`,
    categoryId: c.id,
    weight: streak,
  }
}

/**
 * Before this day of the month, the current month has too few days of data for pace-based
 * findings (projections, comparisons with last month) or a current-month AI analysis.
 */
export const EARLY_MONTH_DAYS = 7

/**
 * Local, deterministic findings for the current month (no AI involved). Ordered by
 * importance: risks first, then good news, then informational ones.
 */
export const computeFindings = (input: {
  readonly today: Day
  readonly categories: ReadonlyArray<CategoryInsightInput>
  readonly topPayees: ReadonlyArray<PayeeTotal>
  /** Everything spent this month, for the top payee's share. */
  readonly monthTotal: number
  readonly newRecurring: ReadonlyArray<NewRecurring>
  readonly limitPerKind?: number
}): Finding[] => {
  const { today, categories, topPayees, newRecurring } = input
  const limit = input.limitPerKind ?? 2
  const strip = ({ weight: _, ...f }: Finding & { weight: number }): Finding => f
  const top = (list: Array<(Finding & { weight: number }) | null>) =>
    list
      .filter((f): f is Finding & { weight: number } => f !== null)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map(strip)

  const early = parseDay(today).d <= EARLY_MONTH_DAYS
  const projections = early ? [] : top(categories.map((c) => projectionFinding(c, today)))
  const flagged = new Set(projections.map((f) => f.categoryId))
  const streaks = top(categories.filter((c) => !flagged.has(c.id)).map(streakFinding))
  const below = early ? [] : top(categories.map((c) => belowLastMonthFinding(c, today)))

  const recurring: Finding[] = newRecurring.slice(0, limit).map((r) => ({
    kind: "new_recurring",
    tone: "warning",
    text: `Nouveau prélèvement récurrent : ${r.payeeName} ${euros(Math.abs(r.amount))}, le ${formatDayShort(r.lastDate)}`,
    context: r.categoryName ? `${r.categoryName} · à ajouter aux échéances` : "Non catégorisé · à affecter",
    payeeId: r.payeeId,
  }))

  const payees: Finding[] = []
  const [first, second] = topPayees
  if (first && first.amount > 0) {
    const total = input.monthTotal
    payees.push({
      kind: "top_payees",
      tone: "accent",
      text: second
        ? `Top bénéficiaire du mois : ${first.name} (${euros(first.amount)}), puis ${second.name} (${euros(second.amount)}).`
        : `Top bénéficiaire du mois : ${first.name} (${euros(first.amount)}).`,
      context: `${count(first.count, "opération")}${total > 0 ? ` · ${pct(first.amount / total)} des dépenses du mois` : ""}`,
      payeeId: first.id,
    })
  }

  return [...projections, ...streaks, ...recurring, ...below, ...payees]
}

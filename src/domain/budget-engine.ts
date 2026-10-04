import { type Month, monthRange } from "./dates"

// Envelope budgeting with the same semantics as Actual's envelope ("zero") budget:
// - a category's available amount rolls over to the next month when positive;
// - a negative amount is taken from next month's "to budget", unless the category
//   has `carryover` set for that month, in which case the debt stays in the category;
// - income is whatever lands in income categories, and "to budget" accumulates across months.

type BudgetCategory = {
  readonly id: string
  readonly isIncome: boolean
}

export type BudgetCell = { readonly amount: number; readonly carryover: boolean }

export type BudgetInputs = {
  readonly categories: ReadonlyArray<BudgetCategory>
  /** Σ transaction amounts per month and category (on-budget accounts, split parents excluded). */
  readonly activity: ReadonlyMap<Month, ReadonlyMap<string, number>>
  readonly budgeted: ReadonlyMap<Month, ReadonlyMap<string, BudgetCell>>
  readonly buffered?: ReadonlyMap<Month, number>
}

type CategoryMonth = {
  readonly budgeted: number
  /** Signed: spending is negative, income is positive. */
  readonly activity: number
  readonly carryIn: number
  readonly available: number
  readonly carryover: boolean
}

export type BudgetMonth = {
  readonly month: Month
  readonly categories: ReadonlyMap<string, CategoryMonth>
  readonly income: number
  readonly fromLastMonth: number
  /** Negative or zero: last month's overspending that was not carried over. */
  readonly lastMonthOverspent: number
  readonly totalBudgeted: number
  /** Signed sum of expense activity (negative when money was spent). */
  readonly totalActivity: number
  readonly totalAvailable: number
  readonly buffered: number
  readonly toBudget: number
}

const EMPTY_CELLS: ReadonlyMap<string, BudgetCell> = new Map()
const EMPTY_ACTIVITY: ReadonlyMap<string, number> = new Map()

/** First month that has any activity or budget, or undefined for an empty budget. */
const firstBudgetMonth = (inputs: BudgetInputs): Month | undefined => {
  let first: Month | undefined
  for (const month of [...inputs.activity.keys(), ...inputs.budgeted.keys(), ...(inputs.buffered?.keys() ?? [])]) {
    if (first === undefined || month < first) first = month
  }
  return first
}

/**
 * Computes every month from the first month with data up to `until`.
 * The whole history must be folded because each month depends on the previous one.
 * Cost is O(months × categories), a few thousand cells for a decade of data.
 */
export const computeBudget = (inputs: BudgetInputs, until: Month): Map<Month, BudgetMonth> => {
  const result = new Map<Month, BudgetMonth>()
  const first = firstBudgetMonth(inputs)
  const start = first === undefined || first > until ? until : first
  let previous: BudgetMonth | undefined
  for (const month of monthRange(start, until)) {
    const current = computeMonth(inputs, month, previous)
    result.set(month, current)
    previous = current
  }
  return result
}

export const computeBudgetMonth = (inputs: BudgetInputs, month: Month): BudgetMonth => {
  const all = computeBudget(inputs, month)
  const found = all.get(month)
  if (!found) throw new Error(`Budget month ${month} was not computed`)
  return found
}

const computeMonth = (inputs: BudgetInputs, month: Month, previous: BudgetMonth | undefined): BudgetMonth => {
  const cells = inputs.budgeted.get(month) ?? EMPTY_CELLS
  const activity = inputs.activity.get(month) ?? EMPTY_ACTIVITY
  const categories = new Map<string, CategoryMonth>()

  let income = 0
  let totalBudgeted = 0
  let totalActivity = 0
  let totalAvailable = 0
  let lastMonthOverspent = 0

  for (const category of inputs.categories) {
    const spent = activity.get(category.id) ?? 0
    if (category.isIncome) {
      income += spent
      categories.set(category.id, { budgeted: 0, activity: spent, carryIn: 0, available: spent, carryover: false })
      continue
    }
    const cell = cells.get(category.id)
    const budgeted = cell?.amount ?? 0
    const prev = previous?.categories.get(category.id)
    let carryIn = 0
    if (prev) {
      if (prev.available >= 0 || prev.carryover) carryIn = prev.available
      else lastMonthOverspent += prev.available
    }
    const available = carryIn + budgeted + spent
    // The carryover flag is sticky: a month without its own budget row inherits the
    // previous month's setting, the same way Actual copies it when a month is created.
    const carryover = cell ? cell.carryover : (prev?.carryover ?? false)
    categories.set(category.id, { budgeted, activity: spent, carryIn, available, carryover })
    totalBudgeted += budgeted
    totalActivity += spent
    totalAvailable += available
  }

  const fromLastMonth = previous ? previous.toBudget + previous.buffered : 0
  const buffered = inputs.buffered?.get(month) ?? 0
  const toBudget = income + fromLastMonth + lastMonthOverspent - totalBudgeted - buffered

  return {
    month,
    categories,
    income,
    fromLastMonth,
    lastMonthOverspent,
    totalBudgeted,
    totalActivity,
    totalAvailable,
    buffered,
    toBudget,
  }
}


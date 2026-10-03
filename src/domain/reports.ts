import { daysInMonth, type Day, type Month } from "./dates"

/** Periods a report can cover, in months counting the current one. */
export const REPORT_MONTHS = [1, 3, 6, 12, 24] as const

/** How far ahead an "upcoming" list can look, in days. */
export const UPCOMING_DAYS = [7, 14, 30] as const

export type MonthValue = { readonly month: Month; readonly value: number }

/** Balance at the end of each month, from the balance before the first one and monthly movements. */
export const runningBalances = (opening: number, movements: ReadonlyMap<Month, number>, months: ReadonlyArray<Month>): MonthValue[] => {
  let balance = opening
  return months.map((month) => {
    balance += movements.get(month) ?? 0
    return { month, value: balance }
  })
}

/**
 * Cumulative total at the end of each day of the month (index 0 is the 1st), stopping after
 * `until` when given: the days after today have no data yet.
 */
export const cumulativeByDay = (daily: ReadonlyMap<Day, number>, month: Month, until?: Day): number[] => {
  const out: number[] = []
  let total = 0
  for (let d = 1; d <= daysInMonth(month); d++) {
    const day = `${month}-${String(d).padStart(2, "0")}`
    if (until !== undefined && day > until) break
    total += daily.get(day) ?? 0
    out.push(total)
  }
  return out
}

/** The `n` largest rows, then one row that adds up the rest (when there is a rest). */
export const topWithRest = <T extends { readonly amount: number }>(
  rows: ReadonlyArray<T>,
  n: number,
  rest: (amount: number, count: number) => T,
): T[] => {
  const sorted = [...rows].sort((a, b) => b.amount - a.amount)
  if (sorted.length <= n + 1) return sorted
  const others = sorted.slice(n)
  return [...sorted.slice(0, n), rest(others.reduce((sum, r) => sum + r.amount, 0), others.length)]
}

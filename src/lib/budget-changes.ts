import type { BudgetMonthDto } from "~/server/services/budget"

/**
 * The month once `changes` (amount added to the budget, per category id) are made, with every total that
 * follows: the groups, the month, what is left to budget and the overspent count. The months after it
 * are left as they were: their carry-in moves too, which only the server computes.
 */
export const withBudgetChanges = (budget: BudgetMonthDto, changes: ReadonlyMap<string, number>): BudgetMonthDto => {
  let total = 0
  let overspentCount = 0
  const groups = budget.groups.map((g) => {
    let delta = 0
    const categories = g.categories.map((c) => {
      const change = changes.get(c.id) ?? 0
      delta += change
      const row = change ? { ...c, budgeted: c.budgeted + change, available: c.available + change } : c
      if (!row.isIncome && row.available < 0) overspentCount++
      return row
    })
    total += delta
    return g.categories.some((c) => changes.has(c.id))
      ? { ...g, budgeted: g.budgeted + delta, available: g.available + delta, categories }
      : g
  })
  return {
    ...budget,
    groups,
    budgeted: budget.budgeted + total,
    available: budget.available + total,
    toBudget: budget.toBudget - total,
    overspentCount,
  }
}

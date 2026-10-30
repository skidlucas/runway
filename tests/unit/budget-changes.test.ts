import { describe, expect, it } from "vitest"
import { withBudgetChanges } from "~/lib/budget-changes"
import type { BudgetCategoryRow, BudgetMonthDto } from "~/server/services/budget"

const category = (id: string, budgeted: number, available: number, isIncome = false): BudgetCategoryRow => ({
  id,
  name: id,
  hidden: false,
  isIncome,
  budgeted,
  spent: budgeted - available,
  available,
  carryIn: 0,
  carryover: false,
  average3: 0,
  lastMonthBudgeted: 0,
  planned: null,
})

const month: BudgetMonthDto = {
  month: "2026-10",
  toBudget: 50000,
  income: 300000,
  budgeted: 60000,
  spent: 55000,
  available: 5000,
  fromLastMonth: 0,
  lastMonthOverspent: 0,
  buffered: 0,
  overspentCount: 1,
  uncategorized: { count: 0, amount: 0 },
  groups: [
    {
      id: "daily",
      name: "Quotidien",
      isIncome: false,
      hidden: false,
      budgeted: 40000,
      spent: 45000,
      available: -5000,
      plannedTotal: 0,
      categories: [category("food", 30000, -8000), category("transport", 10000, 3000)],
    },
    {
      id: "fun",
      name: "Loisirs",
      isIncome: false,
      hidden: false,
      budgeted: 20000,
      spent: 10000,
      available: 10000,
      plannedTotal: 0,
      categories: [category("outings", 20000, 10000)],
    },
  ],
}

describe("withBudgetChanges", () => {
  it("carries a category's new budget through its group, the month and what is left to budget", () => {
    const next = withBudgetChanges(month, new Map([["food", 10000]]))
    expect(next.groups[0]!.categories[0]).toMatchObject({ budgeted: 40000, available: 2000 })
    expect(next.groups[0]).toMatchObject({ budgeted: 50000, available: 5000 })
    expect(next).toMatchObject({ budgeted: 70000, available: 15000, toBudget: 40000, overspentCount: 0 })
    expect(next.groups[1]).toBe(month.groups[1])
  })

  it("moves money between groups without changing what is left to budget", () => {
    const next = withBudgetChanges(month, new Map([["outings", -12000], ["transport", 12000]]))
    expect(next.groups[0]).toMatchObject({ budgeted: 52000, available: 7000 })
    expect(next.groups[1]).toMatchObject({ budgeted: 8000, available: -2000 })
    expect(next).toMatchObject({ budgeted: 60000, toBudget: 50000, overspentCount: 2 })
  })

  it("keeps a group's totals when money moves inside it", () => {
    const next = withBudgetChanges(month, new Map([["transport", -2000], ["food", 2000]]))
    expect(next.groups[0]!.categories.map((c) => c.available)).toEqual([-6000, 1000])
    expect(next.groups[0]).toMatchObject({ budgeted: 40000, available: -5000 })
  })
})

import { describe, expect, it } from "vitest"
import { type BudgetCell, type BudgetInputs, computeBudget, computeBudgetMonth } from "~/domain/budget-engine"

const categories = [
  { id: "income", isIncome: true },
  { id: "food", isIncome: false },
  { id: "transport", isIncome: false },
]

const map = <V>(entries: Record<string, Record<string, V>>) =>
  new Map(Object.entries(entries).map(([month, cells]) => [month, new Map(Object.entries(cells))]))

const cell = (amount: number, carryover = false): BudgetCell => ({ amount, carryover })

describe("budget engine", () => {
  it("computes to-budget from income minus budgeted", () => {
    const inputs: BudgetInputs = {
      categories,
      activity: map({ "2026-10": { income: 284000, food: -28745 } }),
      budgeted: map({ "2026-10": { food: cell(42000), transport: cell(9000) } }),
    }
    const month = computeBudgetMonth(inputs, "2026-10")
    expect(month.income).toBe(284000)
    expect(month.totalBudgeted).toBe(51000)
    expect(month.toBudget).toBe(284000 - 51000)
    expect(month.categories.get("food")).toMatchObject({ budgeted: 42000, activity: -28745, available: 13255 })
    expect(month.totalActivity).toBe(-28745)
  })

  it("rolls positive leftovers forward and accumulates to-budget", () => {
    const inputs: BudgetInputs = {
      categories,
      activity: map({ "2026-09": { income: 100000, food: -30000 }, "2026-10": { food: -5000 } }),
      budgeted: map({ "2026-09": { food: cell(40000) }, "2026-10": { food: cell(10000) } }),
    }
    const result = computeBudget(inputs, "2026-10")
    const sept = result.get("2026-09")!
    const oct = result.get("2026-10")!
    expect(sept.toBudget).toBe(60000)
    expect(oct.fromLastMonth).toBe(60000)
    expect(oct.categories.get("food")).toMatchObject({ carryIn: 10000, available: 15000 })
    expect(oct.toBudget).toBe(50000)
  })

  it("takes overspending from next month's to-budget when carryover is off", () => {
    const inputs: BudgetInputs = {
      categories,
      activity: map({ "2026-09": { income: 100000, transport: -10430 } }),
      budgeted: map({ "2026-09": { transport: cell(9000) } }),
    }
    const oct = computeBudgetMonth(inputs, "2026-10")
    expect(oct.lastMonthOverspent).toBe(-1430)
    expect(oct.categories.get("transport")).toMatchObject({ carryIn: 0, available: 0 })
    expect(oct.toBudget).toBe(100000 - 9000 - 1430)
  })

  it("keeps the debt in the category when carryover is on", () => {
    const inputs: BudgetInputs = {
      categories,
      activity: map({ "2026-09": { income: 100000, transport: -10430 } }),
      budgeted: map({ "2026-09": { transport: cell(9000, true) } }),
    }
    const oct = computeBudgetMonth(inputs, "2026-10")
    expect(oct.lastMonthOverspent).toBe(0)
    expect(oct.categories.get("transport")).toMatchObject({ carryIn: -1430, available: -1430 })
    expect(oct.toBudget).toBe(100000 - 9000)
  })

  it("inherits the carryover flag in months without a budget row", () => {
    const inputs: BudgetInputs = {
      categories,
      activity: map({ "2026-08": { income: 100000 }, "2026-09": { transport: -5000 } }),
      budgeted: map({ "2026-08": { transport: cell(0, true) } }),
    }
    const oct = computeBudgetMonth(inputs, "2026-10")
    expect(oct.categories.get("transport")).toMatchObject({ available: -5000, carryover: true })
    expect(oct.lastMonthOverspent).toBe(0)
  })

  it("subtracts money held for next month and gives it back the month after", () => {
    const inputs: BudgetInputs = {
      categories,
      activity: map({ "2026-09": { income: 100000 } }),
      budgeted: map({}),
      buffered: new Map([["2026-09", 30000]]),
    }
    const result = computeBudget(inputs, "2026-10")
    expect(result.get("2026-09")!.toBudget).toBe(70000)
    expect(result.get("2026-10")!.toBudget).toBe(100000)
  })

  it("handles an empty budget", () => {
    const month = computeBudgetMonth({ categories, activity: new Map(), budgeted: new Map() }, "2026-10")
    expect(month.toBudget).toBe(0)
    expect(month.categories.size).toBe(3)
  })

  it("computes a requested month that is before any data", () => {
    const inputs: BudgetInputs = {
      categories,
      activity: map({ "2026-10": { income: 1000 } }),
      budgeted: map({}),
    }
    expect(computeBudgetMonth(inputs, "2026-01").toBudget).toBe(0)
  })
})

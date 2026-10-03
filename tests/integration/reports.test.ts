import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addMonths, todayIn } from "~/domain/dates"
import { Accounts } from "~/server/services/accounts"
import { Categories } from "~/server/services/categories"
import { Dashboards, DEFAULT_WIDGETS, MAIN_DASHBOARD_ID } from "~/server/services/dashboards"
import { ForecastService } from "~/server/services/forecast"
import { Reports } from "~/server/services/reports"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

const today = todayIn("Europe/Paris")
const month = today.slice(0, 7)
const lastMonth = addMonths(month, -1)

describe("Reports and dashboards", () => {
  let h: Harness
  let checking: string
  let savings: string
  let food: string
  let rent: string
  let salary: string

  beforeAll(async () => {
    h = await createHarness()
    await h.run(Categories.use((c) => c.createStarterSet))
    const tree = await h.run(Categories.use((c) => c.tree))
    const all = tree.flatMap((g) => g.categories.map((c) => ({ ...c, income: g.isIncome })))
    food = all.find((c) => !c.income)!.id
    rent = all.filter((c) => !c.income)[1]!.id
    salary = all.find((c) => c.income)!.id
    const create = (name: string, offBudget: boolean, startingBalance: number) =>
      h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget, startingBalance, startingDate: "2020-01-01" })))
    checking = await create("Courant", false, 100_000)
    savings = await create("Assurance-vie", true, 1_000_000)
    const tx = (date: string, amount: number, categoryId: string | null, payee = "Commerçant") =>
      h.run(Transactions.use((t) => t.create({ accountId: checking, date, amount, payee: { kind: "name", name: payee }, categoryId })))
    await tx(`${lastMonth}-02`, 250_000, salary, "Employeur")
    await tx(`${lastMonth}-03`, -90_000, rent, "Propriétaire")
    await tx(`${lastMonth}-01`, -5_000, food)
    await tx(`${month}-01`, -2_000, food)
    await h.run(Transactions.use((t) => t.create({ accountId: checking, date: `${month}-01`, amount: -10_000, payee: { kind: "transfer", accountId: savings } })))
  }, 60_000)
  afterAll(() => h?.dispose())

  it("adds up income and spending from the budget categories, transfers left out", async () => {
    const flow = await h.run(Reports.use((r) => r.cashFlow(3)))
    expect(flow.months.map((m) => m.month)).toEqual([addMonths(month, -2), lastMonth, month])
    expect(flow.months.slice(1)).toEqual([
      { month: lastMonth, income: 250_000, expenses: 95_000 },
      { month, income: 0, expenses: 2_000 },
    ])
    expect(flow.net).toBe(250_000 - 97_000)
    await expect(h.run(Reports.use((r) => r.cashFlow(5)))).rejects.toThrow("Période invalide")
  })

  it("follows the balance of every account, off-budget ones included", async () => {
    const worth = await h.run(Reports.use((r) => r.netWorth(3)))
    expect(worth.current).toBe(100_000 + 1_000_000 + 250_000 - 97_000)
    expect(worth.months.at(-2)?.value).toBe(100_000 + 1_000_000 + 250_000 - 95_000)
    expect(worth.change).toBe(250_000 - 97_000)
  })

  it("ranks categories and compares this month with the same day last month", async () => {
    const spending = await h.run(Reports.use((r) => r.categorySpending(3)))
    expect(spending.rows.map((r) => [r.id, r.amount])).toEqual([
      [rent, 90_000],
      [food, 7_000],
    ])
    const comparison = await h.run(Reports.use((r) => r.spendingComparison))
    expect(comparison.total).toBe(2_000)
    expect(comparison.previousSeries.at(-1)).toBe(95_000)
    expect(comparison.current).toHaveLength(Number(today.slice(8, 10)))
  })

  it("shows a default dashboard until it is changed, then stores it", async () => {
    expect(await h.run(Dashboards.use((d) => d.list))).toEqual([{ id: MAIN_DASHBOARD_ID, name: "Principal", widgets: DEFAULT_WIDGETS }])
    const widgets = [{ id: "w", kind: "cash_flow" as const, size: 3 as const, months: 12 }]
    await h.run(Dashboards.use((d) => d.save(MAIN_DASHBOARD_ID, { widgets })))
    const other = await h.run(Dashboards.use((d) => d.create("Patrimoine")))
    expect((await h.run(Dashboards.use((d) => d.list))).map((d) => [d.name, d.widgets])).toEqual([
      ["Principal", widgets],
      ["Patrimoine", []],
    ])
    await expect(h.run(Dashboards.use((d) => d.save(other.id, { widgets: [{ id: "x", kind: "net_worth", size: 2, months: 7 }] })))).rejects.toThrow(
      "Widget invalide",
    )
  })

  it("gives each budget account its share of the remaining budget", async () => {
    // Actual has no account kinds: an imported savings account comes in as "checking".
    const create = (name: string) =>
      h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget: false, startingBalance: 50_000, startingDate: "2020-01-01" })))
    const livret = await create("Livret importé")
    const cash = await create("Espèces")
    await h.run(Transactions.use((t) => t.create({ accountId: cash, date: today, amount: -5_000, payee: { kind: "name", name: "Marché" }, categoryId: food })))
    const forecast = (accountId: string, withBudget?: boolean) =>
      h.run(ForecastService.use((f) => f.month({ accountId, ...(withBudget === undefined ? {} : { withBudget }) })))

    const saving = await forecast(livret)
    expect(saving).toMatchObject({ budgetShare: 0, withBudget: false, remainingToSpend: 0, projectedEndBalance: 50_000 })
    const [main, coins] = await Promise.all([forecast(checking), forecast(cash)])
    expect(coins.budgetShare).toBeGreaterThan(0)
    expect(main.budgetShare + coins.budgetShare).toBeCloseTo(1)
    expect((await forecast(livret, true)).budgetShare).toBe(1)
  })
})

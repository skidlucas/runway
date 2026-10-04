import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { Schedules } from "~/server/services/schedules"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

describe("Budget moves", () => {
  let h: Harness
  let a: string
  let b: string
  let c: string
  const rows = async (month: string) => (await h.run(Budget.use((s) => s.month(month)))).groups.flatMap((g) => g.categories)
  const budgeted = async (month: string, id: string) => (await rows(month)).find((x) => x.id === id)!.budgeted
  const toBudget = async (month: string) => (await h.run(Budget.use((s) => s.month(month)))).toBudget

  beforeAll(async () => {
    h = await createHarness()
    await h.run(Categories.use((s) => s.createStarterSet))
    const tree = await h.run(Categories.use((s) => s.tree))
    ;[a, b, c] = tree.filter((g) => !g.isIncome).flatMap((g) => g.categories.map((x) => x.id)) as [string, string, string]
  }, 60_000)
  afterAll(() => h?.dispose())

  it("does nothing when a category is moved onto itself", async () => {
    await h.run(Budget.use((s) => s.setAmount("2026-01", a, 10_000)))
    await h.run(Budget.use((s) => s.move("2026-01", { kind: "category", id: a }, { kind: "category", id: a }, 3_000)))
    expect(await budgeted("2026-01", a)).toBe(10_000)
  })

  it("keeps both of two moves made at the same time", async () => {
    const month = "2026-02"
    await h.run(Budget.use((s) => s.setAmount(month, a, 10_000)))
    await h.run(
      Effect.all(
        [
          Budget.use((s) => s.move(month, { kind: "category", id: a }, { kind: "category", id: b }, 1_000)),
          Budget.use((s) => s.move(month, { kind: "category", id: a }, { kind: "category", id: c }, 2_000)),
        ],
        { concurrency: "unbounded" },
      ),
    )
    expect([await budgeted(month, a), await budgeted(month, b), await budgeted(month, c)]).toEqual([7_000, 1_000, 2_000])
  })

  it("moves money from and back to the amount left to budget", async () => {
    const month = "2026-03"
    const before = await toBudget(month)
    await h.run(Budget.use((s) => s.move(month, { kind: "toBudget" }, { kind: "category", id: b }, 4_000)))
    expect([await budgeted(month, b), await toBudget(month)]).toEqual([4_000, before - 4_000])
    await h.run(Budget.use((s) => s.move(month, { kind: "category", id: b }, { kind: "toBudget" }, 1_500)))
    expect([await budgeted(month, b), await toBudget(month)]).toEqual([2_500, before - 2_500])
    await h.run(Budget.use((s) => s.move(month, { kind: "toBudget" }, { kind: "toBudget" }, 1_000)))
    expect(await toBudget(month)).toBe(before - 2_500)
  })

  it("refuses an amount that is zero, negative or not in cents", async () => {
    for (const amount of [0, -100, 10.5]) {
      const error = await h.fail(Budget.use((s) => s.move("2026-04", { kind: "toBudget" }, { kind: "category", id: a }, amount)))
      expect(error._tag, String(amount)).toBe("Invalid")
    }
    expect(await budgeted("2026-04", a)).toBe(0)
  })

  it("keeps the carryover a category inherits when money moves into a new month", async () => {
    await h.run(Budget.use((s) => s.setCarryover("2026-08", c, true)))
    await h.run(Budget.use((s) => s.move("2026-10", { kind: "toBudget" }, { kind: "category", id: c }, 500)))
    const october = (await rows("2026-10")).find((x) => x.id === c)!
    expect(october.carryover).toBe(true)
  })
})

describe("Budget engine", () => {
  let h: Harness
  let account: string
  const ids: Record<string, string> = {}
  const month = (m: string) => h.run(Budget.use((s) => s.month(m)))
  const row = async (m: string, name: string) => (await month(m)).groups.flatMap((g) => g.categories).find((x) => x.name === name)!
  const spend = (date: string, category: string, amount: number) =>
    h.run(Transactions.use((s) => s.create({ accountId: account, date, amount, payee: { kind: "name", name: category }, categoryId: ids[category]! })))
  const budget = (m: string, category: string, amount: number) => h.run(Budget.use((s) => s.setAmount(m, ids[category]!, amount)))
  const FEBRUARY = "2026-02"
  const febBudgets = async () =>
    Object.fromEntries((await month(FEBRUARY)).groups.flatMap((g) => g.categories).filter((c) => !c.isIncome).map((c) => [c.name, c.budgeted]))

  beforeAll(async () => {
    h = await createHarness({ now: "2026-10-04T10:00:00Z" })
    await h.run(Categories.use((s) => s.createStarterSet))
    for (const g of await h.run(Categories.use((s) => s.tree))) for (const c of g.categories) ids[c.name] = c.id
    await h.run(Categories.use((s) => s.update(ids.Santé!, { hidden: true })))
    account = await h.run(
      Accounts.use((s) => s.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2025-10-01" })),
    )

    await spend("2025-10-01", "Revenus", 300_000)
    await spend("2025-10-02", "Loyer", -100_000)
    await spend("2025-10-05", "Courses", -40_000)
    await spend("2025-10-20", "Courses", -20_000)
    await spend("2025-10-25", "Santé", -5_000)
    await budget("2025-10", "Loyer", 100_000)
    await budget("2025-10", "Courses", 50_000)
    await budget("2025-10", "Transport", 10_000)
    await h.d1.prepare("INSERT INTO budget_months (month, buffered) VALUES ('2025-10', 50000)").run()

    await spend("2025-11-12", "Courses", -30_000)
    await spend("2025-11-14", "Transport", -10_000)

    await spend("2025-12-01", "Revenus", 200_000)
    await spend("2025-12-15", "Courses", -50_000)
    await spend("2025-12-31", "Transport", -20_000)
    await budget("2025-12", "Loyer", 100_000)
    await budget("2025-12", "Courses", 50_000)
    await budget("2025-12", "Transport", 15_000)

    await spend("2026-01-01", "Revenus", 150_000)
    await spend("2026-01-01", "Courses", -10_050)
    await budget("2026-01", "Loyer", 100_000)
    await budget("2026-01", "Courses", 40_000)

    await spend("2026-02-10", "Courses", -25_000)
    await budget(FEBRUARY, "Santé", 1_234)
  }, 60_000)
  afterAll(() => h?.dispose())

  it("sets money held for next month aside, and gives it back the month after", async () => {
    expect(await month("2025-10")).toMatchObject({ income: 300_000, budgeted: 160_000, buffered: 50_000, toBudget: 90_000 })
    expect(await month("2025-11")).toMatchObject({ fromLastMonth: 140_000, lastMonthOverspent: -15_000, buffered: 0, toBudget: 125_000 })
  })

  it("counts the spending of a hidden category, and takes its overspending from the next month", async () => {
    const october = await month("2025-10")
    const health = october.groups.flatMap((g) => g.categories).find((c) => c.name === "Santé")!
    expect(health).toMatchObject({ hidden: true, budgeted: 0, spent: 5_000, available: -5_000 })
    expect(october).toMatchObject({ spent: 165_000, available: -5_000, overspentCount: 2 })
    expect((await row("2025-11", "Santé")).carryIn).toBe(0)
  })

  it("rolls the budget over from December to January", async () => {
    expect(await month("2025-12")).toMatchObject({ income: 200_000, budgeted: 165_000, lastMonthOverspent: -30_000, toBudget: 130_000 })
    expect(await row("2025-12", "Transport")).toMatchObject({ spent: 20_000, available: -5_000 })
    expect(await month("2026-01")).toMatchObject({ income: 150_000, fromLastMonth: 130_000, lastMonthOverspent: -5_000, toBudget: 135_000 })
    expect(await row("2026-01", "Loyer")).toMatchObject({ carryIn: 100_000, available: 200_000, lastMonthBudgeted: 100_000 })
    // average3 covers October to December: (60 000 + 30 000 + 50 000) / 3.
    expect(await row("2026-01", "Courses")).toMatchObject({ spent: 10_050, available: 29_950, average3: 46_667 })
    expect(await row("2026-01", "Transport")).toMatchObject({ carryIn: 0, available: 0 })
  })

  it("refuses a month that does not exist", async () => {
    for (const bad of ["2026-13", "2026-1", "26-01", "2026-00"]) {
      expect((await h.fail(Budget.use((s) => s.month(bad))))._tag, bad).toBe("Invalid")
      expect((await h.fail(Budget.use((s) => s.setAmount(bad, ids.Courses!, 100))))._tag, bad).toBe("Invalid")
      expect((await h.fail(Budget.use((s) => s.fill(bad, { kind: "zero" }))))._tag, bad).toBe("Invalid")
      expect((await h.fail(Budget.use((s) => s.setCarryover(bad, ids.Courses!, true))))._tag, bad).toBe("Invalid")
    }
    expect((await h.fail(Budget.use((s) => s.setAmount(FEBRUARY, ids.Courses!, 10.5))))._tag).toBe("Invalid")
  })

  // Every fill below writes all the visible expense categories of February, so each one starts
  // from the same state whatever ran before it.
  it("fills with last month's budgets, hidden and income categories aside", async () => {
    expect(await h.run(Budget.use((s) => s.fill(FEBRUARY, { kind: "copyLastMonth" })))).toBe(10)
    expect(await febBudgets()).toMatchObject({ Loyer: 100_000, Courses: 40_000, Transport: 0, Internet: 0, Santé: 1_234 })
  })

  it("fills with the average spending of the previous months, rounded to the euro", async () => {
    await h.run(Budget.use((s) => s.fill(FEBRUARY, { kind: "average", months: 3 })))
    // Courses: (30 000 + 50 000 + 10 050) / 3 = 30 016.67 cents; Loyer was only spent in October.
    expect(await febBudgets()).toMatchObject({ Loyer: 0, Courses: 30_000, Transport: 10_000, Santé: 1_234 })
  })

  it("fills with what was spent this month", async () => {
    await h.run(Budget.use((s) => s.fill(FEBRUARY, { kind: "spent" })))
    expect(await febBudgets()).toMatchObject({ Loyer: 0, Courses: 25_000, Transport: 0, Santé: 1_234 })
  })

  it("empties every visible budget", async () => {
    await h.run(Budget.use((s) => s.fill(FEBRUARY, { kind: "copyLastMonth" })))
    await h.run(Budget.use((s) => s.fill(FEBRUARY, { kind: "zero" })))
    expect(Object.entries(await febBudgets()).filter(([, amount]) => amount !== 0)).toEqual([["Santé", 1_234]])
  })

  it("fills only the chosen categories", async () => {
    await h.run(Budget.use((s) => s.fill(FEBRUARY, { kind: "zero" })))
    expect(await h.run(Budget.use((s) => s.fill(FEBRUARY, { kind: "copyLastMonth" }, [ids.Courses!])))).toBe(1)
    expect(await febBudgets()).toMatchObject({ Loyer: 0, Courses: 40_000 })
  })

  it("applies a carryover to the later months already budgeted, and keeps the debt in the category", async () => {
    await spend("2026-04-10", "Internet", -3_000)
    await budget("2026-05", "Internet", 1_000)
    await budget("2026-07", "Internet", 1_000)
    const flags = async () =>
      (
        await h.d1
          .prepare("SELECT month, carryover FROM budgets WHERE category_id = ? AND month >= '2026-04' ORDER BY month")
          .bind(ids.Internet)
          .all<{ month: string; carryover: number }>()
      ).results

    await h.run(Budget.use((s) => s.setCarryover("2026-04", ids.Internet!, true)))
    expect(await flags()).toEqual([
      { month: "2026-04", carryover: 1 },
      { month: "2026-05", carryover: 1 },
      { month: "2026-07", carryover: 1 },
    ])
    expect((await month("2026-05")).lastMonthOverspent).toBe(0)
    expect(await row("2026-05", "Internet")).toMatchObject({ carryIn: -3_000, available: -2_000, carryover: true })
    expect(await row("2026-06", "Internet")).toMatchObject({ carryIn: -2_000, available: -2_000, carryover: true })
    expect(await row("2026-07", "Internet")).toMatchObject({ available: -1_000, carryover: true })

    await h.run(Budget.use((s) => s.setCarryover("2026-04", ids.Internet!, false)))
    expect((await flags()).map((r) => r.carryover)).toEqual([0, 0, 0])
    expect((await month("2026-05")).lastMonthOverspent).toBe(-3_000)
    expect(await row("2026-05", "Internet")).toMatchObject({ carryIn: 0, available: 1_000, carryover: false })
  })
})

describe("Budget planned from schedules", () => {
  let h: Harness
  let a: string
  let b: string
  let c: string
  const month = "2030-01"
  const rows = async () => (await h.run(Budget.use((s) => s.month(month)))).groups.flatMap((g) => g.categories)
  const row = async (id: string) => (await rows()).find((x) => x.id === id)!

  beforeAll(async () => {
    h = await createHarness()
    await h.run(Categories.use((s) => s.createStarterSet))
    const tree = await h.run(Categories.use((s) => s.tree))
    ;[a, b, c] = tree.filter((g) => !g.isIncome).flatMap((g) => g.categories.map((x) => x.id)) as [string, string, string]
    const accountId = await h.run(
      Accounts.use((s) => s.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2029-12-01" })),
    )
    const create = (name: string, categoryId: string, amount: number, unit: "month" | "year", startDate: string, endDate?: string) =>
      h.run(
        Schedules.use((s) =>
          s.create({ name, payee: { kind: "name", name }, accountId, categoryId, amount, recurrence: { unit, interval: 1 }, startDate, endDate, autoPost: false }),
        ),
      )
    await create("Box", a, -5_000, "month", "2030-01-15", "2030-12-15")
    await create("Assurance", b, -60_000, "year", "2030-06-15")
    await h.run(Budget.use((s) => s.setAmount(month, c, 7_000)))
  }, 60_000)
  afterAll(() => h?.dispose())

  it("shows what each category's schedules need this month", async () => {
    expect((await row(a)).planned).toMatchObject({ amount: 5_000, due: 5_000 })
    expect((await row(a)).planned?.lines[0]?.remaining).toEqual({ count: 12, total: 60_000, until: "2030-12-15" })
    expect((await row(b)).planned).toMatchObject({ amount: 10_000, setAside: 10_000 })
    expect((await row(c)).planned).toBeNull()
  })

  it("budgets the schedules without touching the categories that have none", async () => {
    expect(await h.run(Budget.use((s) => s.fill(month, { kind: "planned" })))).toBe(2)
    expect([(await row(a)).budgeted, (await row(b)).budgeted, (await row(c)).budgeted]).toEqual([5_000, 10_000, 7_000])
  })

  it("never lowers a budget above what the schedules need", async () => {
    const february = "2030-02"
    await h.run(Budget.use((s) => s.setAmount(february, a, 9_000)))
    await h.run(Budget.use((s) => s.fill(february, { kind: "planned" })))
    expect((await h.run(Budget.use((s) => s.month(february)))).groups.flatMap((g) => g.categories).find((x) => x.id === a)!.budgeted).toBe(9_000)
  })
})

describe("Budget planned from a yearly bill", () => {
  let h: Harness
  let accountId: string
  let c: string

  beforeAll(async () => {
    h = await createHarness()
    await h.run(Categories.use((s) => s.createStarterSet))
    c = (await h.run(Categories.use((s) => s.tree))).find((g) => !g.isIncome)!.categories[0]!.id
    accountId = await h.run(
      Accounts.use((s) => s.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2029-12-01" })),
    )
  }, 60_000)
  afterAll(() => h?.dispose())

  it("does not ask again in its month for a yearly bill paid early, and keeps one paid on time", async () => {
    const bill = (name: string) =>
      h.run(
        Schedules.use((s) =>
          s.create({ name, payee: { kind: "name", name }, accountId, categoryId: c, amount: -60_000, recurrence: { unit: "year", interval: 1 }, startDate: "2030-11-03", autoPost: false }),
        ),
      )
    const early = await bill("Taxe payée en avance")
    const onTime = await bill("Taxe payée à l'heure")
    await h.run(Schedules.use((s) => s.post(early, "2030-10-30")))
    await h.run(Schedules.use((s) => s.post(onTime, "2030-11-03")))
    const lines = async (m: string) =>
      (await h.run(Budget.use((s) => s.month(m)))).groups.flatMap((g) => g.categories).find((x) => x.id === c)!.planned?.lines ?? []
    const november = await lines("2030-11")
    expect(november.find((l) => l.scheduleId === early)).toMatchObject({ date: "2031-11-03", monthsLeft: 13 })
    expect(november.find((l) => l.scheduleId === onTime)).toMatchObject({ date: "2030-11-03", monthsLeft: 1 })
    expect((await lines("2030-10")).find((l) => l.scheduleId === early)).toMatchObject({ date: "2030-10-30", monthsLeft: 1 })
  })
})

describe("Age of money", () => {
  let h: Harness

  beforeAll(async () => {
    h = await createHarness()
    const account = (name: string, offBudget: boolean, startingBalance: number) =>
      h.run(Accounts.use((s) => s.create({ name, kind: "checking", offBudget, startingBalance, startingDate: "2026-01-01" })))
    const checking = await account("Courant", false, 100_000)
    const savings = await account("Livret", false, 0)
    const broker = await account("Courtier", true, 0)
    const add = (date: string, amount: number, payee: { kind: "name"; name: string } | { kind: "transfer"; accountId: string }) =>
      h.run(Transactions.use((s) => s.create({ accountId: checking, date, amount, payee, categoryId: null })))
    await add("2026-01-31", 100_000, { kind: "name", name: "Salaire" })
    await add("2026-02-10", -50_000, { kind: "name", name: "Loyer" })
    await add("2026-02-15", -30_000, { kind: "transfer", accountId: savings })
    await add("2026-02-20", -50_000, { kind: "transfer", accountId: broker })
    await add("2026-03-05", -10_000, { kind: "name", name: "Courses" })
  }, 60_000)
  afterAll(() => h?.dispose())

  it("ages the money spent out of the budget, transfers between budget accounts aside", async () => {
    // The rent waited 40 days, the money sent to the broker 50; the savings transfer stays in the budget.
    expect(await h.run(Budget.use((s) => s.ageOfMoney("2026-02")))).toBe(45)
  })

  it("has no age before the first outflow", async () => {
    expect(await h.run(Budget.use((s) => s.ageOfMoney("2026-01")))).toBeNull()
  })
})

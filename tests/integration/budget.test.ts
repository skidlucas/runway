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
  const month = "2026-09"
  const budgeted = async (id: string) =>
    (await h.run(Budget.use((s) => s.month(month)))).groups.flatMap((g) => g.categories).find((x) => x.id === id)!.budgeted

  beforeAll(async () => {
    h = await createHarness()
    await h.run(Categories.use((s) => s.createStarterSet))
    const tree = await h.run(Categories.use((s) => s.tree))
    ;[a, b, c] = tree.filter((g) => !g.isIncome).flatMap((g) => g.categories.map((x) => x.id)) as [string, string, string]
    await h.run(Budget.use((s) => s.setAmount(month, a, 10_000)))
  }, 60_000)
  afterAll(() => h?.dispose())

  it("does nothing when a category is moved onto itself", async () => {
    await h.run(Budget.use((s) => s.move(month, { kind: "category", id: a }, { kind: "category", id: a }, 3_000)))
    expect(await budgeted(a)).toBe(10_000)
  })

  it("keeps both of two moves made at the same time", async () => {
    await h.run(
      Effect.all(
        [
          Budget.use((s) => s.move(month, { kind: "category", id: a }, { kind: "category", id: b }, 1_000)),
          Budget.use((s) => s.move(month, { kind: "category", id: a }, { kind: "category", id: c }, 2_000)),
        ],
        { concurrency: "unbounded" },
      ),
    )
    expect([await budgeted(a), await budgeted(b), await budgeted(c)]).toEqual([7_000, 1_000, 2_000])
  })

  it("keeps the carryover a category inherits when money moves into a new month", async () => {
    await h.run(Budget.use((s) => s.setCarryover("2026-08", c, true)))
    await h.run(Budget.use((s) => s.move("2026-10", { kind: "toBudget" }, { kind: "category", id: c }, 500)))
    const october = (await h.run(Budget.use((s) => s.month("2026-10")))).groups.flatMap((g) => g.categories).find((x) => x.id === c)!
    expect(october.carryover).toBe(true)
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

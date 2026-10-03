import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
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
    expect((await h.run(Budget.use((s) => s.month("2026-02")))).ageOfMoney).toBe(45)
  })

  it("has no age before the first outflow", async () => {
    expect((await h.run(Budget.use((s) => s.month("2026-01")))).ageOfMoney).toBeNull()
  })
})

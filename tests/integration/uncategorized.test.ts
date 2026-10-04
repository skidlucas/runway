import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { Insights } from "~/server/services/insights"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

const NOW = "2026-10-04T10:00:00Z"
const today = "2026-10-04"
const month = "2026-10"

describe("Uncategorized operations", () => {
  let h: Harness
  let checking: string

  beforeAll(async () => {
    h = await createHarness({ now: NOW })
    await h.run(Categories.use((c) => c.createStarterSet))
    const create = (name: string, offBudget: boolean) =>
      h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget, startingBalance: 0, startingDate: `${month}-01` })))
    checking = await create("Courant", false)
    const savings = await create("Livret", false)
    const broker = await create("Courtier", true)
    const tx = (amount: number, payee: Parameters<Transactions["Service"]["create"]>[0]["payee"]) =>
      h.run(Transactions.use((t) => t.create({ accountId: checking, date: today, amount, payee, categoryId: null })))
    await tx(-1_000, { kind: "name", name: "Boulangerie" })
    await tx(-20_000, { kind: "transfer", accountId: broker })
    await tx(-50_000, { kind: "transfer", accountId: savings })
  }, 60_000)
  afterAll(() => h?.dispose())

  it("agree between the budget banner, its register filter and the insights", async () => {
    const banner = (await h.run(Budget.use((b) => b.month(month)))).uncategorized
    expect(banner).toEqual({ count: 2, amount: -21_000 })

    const register = await h.run(Transactions.use((t) => t.list({ uncategorized: true, month })))
    expect(register.total).toBe(2)

    const expenses = await h.run(Insights.use((s) => s.view({ measure: "expenses", target: { kind: "all" }, months: 3, rolling: 0 })))
    expect(expenses.bars.at(-1)?.value).toBe(21_000)
  })

  it("leave a transfer between two budget accounts out", async () => {
    const register = await h.run(Transactions.use((t) => t.list({ uncategorized: true, accountId: checking })))
    expect(register.rows.map((r) => r.amount).sort()).toEqual([-1_000, -20_000])
  })
})

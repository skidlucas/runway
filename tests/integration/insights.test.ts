import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addMonths, todayIn } from "~/domain/dates"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { Demo } from "~/server/services/demo"
import { Insights } from "~/server/services/insights"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

let h: Harness
const today = todayIn("Europe/Paris")
const month = today.slice(0, 7)
const ids = { checking: "", restaurants: "", courses: "", groupLoisirs: "" }

beforeAll(async () => {
  h = await createHarness()
  await h.run(Categories.use((c) => c.createStarterSet))
  const tree = await h.run(Categories.use((c) => c.tree))
  const cat = (name: string) => tree.flatMap((g) => g.categories).find((c) => c.name === name)!.id
  ids.restaurants = cat("Restaurants")
  ids.courses = cat("Courses")
  ids.groupLoisirs = tree.find((g) => g.name === "Loisirs")!.id
  ids.checking = await h.run(
    Accounts.use((a) =>
      a.create({
        name: "Compte courant",
        kind: "checking",
        offBudget: false,
        startingBalance: 500_000,
        startingDate: `${addMonths(month, -4)}-01`,
      }),
    ),
  )
  const spend = (m: string, day: string, amount: number, payee: string, categoryId: string) =>
    h.run(
      Transactions.use((t) =>
        t.create({ accountId: ids.checking, date: `${m}-${day}`, amount: -amount, payee: { kind: "name", name: payee }, categoryId }),
      ),
    )
  for (const delta of [-3, -2, -1]) {
    const m = addMonths(month, delta)
    await spend(m, "01", 10_000, "Le Comptoir", ids.restaurants)
    await spend(m, "20", 5000, "Deliveroo", ids.restaurants)
    await spend(m, "05", 30_000, "Monoprix", ids.courses)
  }
  await spend(month, "01", 4000, "Le Comptoir", ids.restaurants)
  await h.run(Budget.use((b) => b.setAmount(month, ids.restaurants, 12_000)))
})
afterAll(async () => {
  await h?.dispose()
})

describe("insights view", () => {
  it("aggregates a category month by month with a trailing average", async () => {
    const view = await h.run(
      Insights.use((s) => s.view({ measure: "expenses", target: { kind: "category", id: ids.restaurants }, months: 3, rolling: 3 })),
    )
    expect(view.label).toBe("Restaurants")
    expect(view.bars.map((b) => [b.month, b.value])).toEqual([
      [addMonths(month, -2), 15_000],
      [addMonths(month, -1), 15_000],
      [month, 4000],
    ])
    expect(view.average).toBe(15_000)
    expect(view.current).toBe(4000)
    expect(view.budget).toBe(12_000)
    expect(view.breakdown.by).toBe("payee")
    expect(view.breakdown.rows.map((r) => [r.name, r.amount, r.count])).toEqual([
      ["Le Comptoir", 24_000, 3],
      ["Deliveroo", 10_000, 2],
    ])
  })

  it("aggregates a group, all expenses, and a payee by category", async () => {
    const group = await h.run(
      Insights.use((s) => s.view({ measure: "expenses", target: { kind: "group", id: ids.groupLoisirs }, months: 3, rolling: 0 })),
    )
    expect(group.periodTotal).toBe(34_000)
    expect(group.average).toBeNull()
    const all = await h.run(Insights.use((s) => s.view({ measure: "expenses", target: { kind: "all" }, months: 6, rolling: 0 })))
    expect(all.periodTotal).toBe(3 * 45_000 + 4000)
    const income = await h.run(Insights.use((s) => s.view({ measure: "income", target: { kind: "all" }, months: 6, rolling: 0 })))
    expect(income.periodTotal).toBe(0)

    const payees = await h.run(Insights.use((s) => s.view({ measure: "expenses", target: { kind: "all" }, months: 3, rolling: 0 })))
    const monoprix = payees.breakdown.rows.find((r) => r.name === "Monoprix")!
    const byCategory = await h.run(
      Insights.use((s) => s.view({ measure: "expenses", target: { kind: "payee", id: monoprix.id! }, months: 3, rolling: 0 })),
    )
    expect(byCategory.breakdown).toEqual({ by: "category", rows: [{ id: ids.courses, name: "Courses", amount: 60_000, count: 2 }] })
  })

  it("rejects unknown targets and options", async () => {
    await expect(
      h.run(Insights.use((s) => s.view({ measure: "expenses", target: { kind: "category", id: "nope" }, months: 3, rolling: 0 }))),
    ).rejects.toThrow()
    await expect(
      h.run(Insights.use((s) => s.view({ measure: "expenses", target: { kind: "all" }, months: 5, rolling: 0 }))),
    ).rejects.toThrow(/invalide/)
  })
})

describe("saved views", () => {
  it("saves, lists and deletes", async () => {
    const config = { measure: "expenses" as const, target: { kind: "category" as const, id: ids.restaurants }, months: 6, rolling: 6 as const }
    const saved = await h.run(Insights.use((s) => s.saveView("Restaurants · 6 mois", config)))
    expect(await h.run(Insights.use((s) => s.savedViews))).toEqual([saved])
    await h.run(Insights.use((s) => s.deleteView(saved.id)))
    expect(await h.run(Insights.use((s) => s.savedViews))).toEqual([])
  })
})

describe("findings", () => {
  it("produces findings on the demo budget", async () => {
    const fresh = await createHarness()
    try {
      await fresh.run(Demo.use((d) => d.seed))
      const result = await fresh.run(Insights.use((s) => s.findings))
      expect(result.month).toBe(month)
      expect(result.findings.length).toBeGreaterThan(0)
      expect(result.findings.some((f) => f.kind === "top_payees")).toBe(true)
      for (const f of result.findings) {
        expect(f.text.length).toBeGreaterThan(10)
        expect(f.context.length).toBeGreaterThan(0)
      }
    } finally {
      await fresh.dispose()
    }
  })
})

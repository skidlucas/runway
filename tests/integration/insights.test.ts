import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addMonths } from "~/domain/dates"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import type { InsightViewConfig } from "~/server/db/schema"
import { Categories } from "~/server/services/categories"
import { Dashboards } from "~/server/services/dashboards"
import { Demo } from "~/server/services/demo"
import { Insights } from "~/server/services/insights"
import { Payees } from "~/server/services/payees"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

let h: Harness
const NOW = "2026-10-04T10:00:00Z"
const month = "2026-10"
const ids = { checking: "", restaurants: "", courses: "", groupLoisirs: "" }

beforeAll(async () => {
  h = await createHarness({ now: NOW })
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
    expect(group.budget).toBe(12_000)
    const all = await h.run(Insights.use((s) => s.view({ measure: "expenses", target: { kind: "all" }, months: 6, rolling: 0 })))
    expect(all.periodTotal).toBe(3 * 45_000 + 4000)
    expect(all.budget).toBe(12_000)
    const income = await h.run(Insights.use((s) => s.view({ measure: "income", target: { kind: "all" }, months: 6, rolling: 0 })))
    expect(income.periodTotal).toBe(0)

    const payees = await h.run(Insights.use((s) => s.view({ measure: "expenses", target: { kind: "all" }, months: 3, rolling: 0 })))
    const monoprix = payees.breakdown.rows.find((r) => r.name === "Monoprix")!
    const byCategory = await h.run(
      Insights.use((s) => s.view({ measure: "expenses", target: { kind: "payee", id: monoprix.id! }, months: 3, rolling: 0 })),
    )
    expect(byCategory.breakdown).toEqual({ by: "category", rows: [{ id: ids.courses, name: "Courses", amount: 60_000, count: 2 }] })
  })

  it("names a missing target instead of failing, and rejects unknown options", async () => {
    const missing = await h.run(
      Insights.use((s) => s.view({ measure: "expenses", target: { kind: "category", id: "nope" }, months: 3, rolling: 0 })),
    )
    expect(missing.label).toBe("Catégorie supprimée")
    expect(missing.bars.every((b) => b.value === 0)).toBe(true)
    await expect(
      h.run(Insights.use((s) => s.view({ measure: "expenses", target: { kind: "all" }, months: 5 as never, rolling: 0 }))),
    ).rejects.toThrow(/invalide/)
  })
})

describe("saved views", () => {
  it("saves, lists and deletes", async () => {
    const config = { measure: "expenses" as const, target: { kind: "category" as const, id: ids.restaurants }, months: 6 as const, rolling: 6 as const }
    const saved = await h.run(Insights.use((s) => s.saveView("Restaurants · 6 mois", config)))
    expect((await h.run(Insights.use((s) => s.savedViews))).filter((v) => v.id === saved.id)).toEqual([saved])
    await h.run(Insights.use((s) => s.deleteView(saved.id)))
    expect((await h.run(Insights.use((s) => s.savedViews))).map((v) => v.id)).not.toContain(saved.id)
  })

  it("follows its target when a category, a group or a payee goes away", async () => {
    const save = (target: InsightViewConfig["target"]) =>
      h.run(Insights.use((s) => s.saveView("Vue", { measure: "expenses", target, months: 3, rolling: 0 })))
    const targetOf = async (id: string) => (await h.run(Insights.use((s) => s.savedViews))).find((v) => v.id === id)!.config.target
    const group = await h.run(Categories.use((c) => c.createGroup({ name: "Temporaire" })))
    const cinema = await h.run(Categories.use((c) => c.create({ groupId: group.id, name: "Cinéma" })))
    const concerts = await h.run(Categories.use((c) => c.create({ groupId: group.id, name: "Concerts" })))
    const theatre = await h.run(Categories.use((c) => c.create({ groupId: group.id, name: "Théâtre" })))

    const reassigned = await save({ kind: "category", id: cinema.id })
    await h.run(Categories.use((c) => c.remove(cinema.id, ids.restaurants)))
    expect(await targetOf(reassigned.id)).toEqual({ kind: "category", id: ids.restaurants })

    const dropped = await save({ kind: "category", id: concerts.id })
    await h.run(Categories.use((c) => c.remove(concerts.id, null)))
    expect(await targetOf(dropped.id)).toEqual({ kind: "group", id: group.id })

    const onGroup = await save({ kind: "group", id: group.id })
    const onCategory = await save({ kind: "category", id: theatre.id })
    await h.run(Categories.use((c) => c.deleteGroup(group.id, null)))
    expect(await targetOf(onGroup.id)).toEqual({ kind: "all" })
    expect(await targetOf(onCategory.id)).toEqual({ kind: "all" })
    expect(await targetOf(dropped.id)).toEqual({ kind: "all" })

    const payeeIds = await h.run(Payees.use((p) => p.resolveNames(["Le Comptoir", "Comptoir (ancien)"])))
    const onPayee = await save({ kind: "payee", id: payeeIds.get("Comptoir (ancien)")! })
    await h.run(Payees.use((p) => p.deleteUnused))
    const kept = await h.d1.prepare("SELECT COUNT(*) AS n FROM payees WHERE id = ?").bind(payeeIds.get("Comptoir (ancien)")).first<{ n: number }>()
    expect(kept?.n).toBe(1)
    await h.run(Payees.use((p) => p.merge([payeeIds.get("Comptoir (ancien)")!], payeeIds.get("Le Comptoir")!)))
    expect(await targetOf(onPayee.id)).toEqual({ kind: "payee", id: payeeIds.get("Le Comptoir") })
  })

  it("removes a deleted view from the dashboards", async () => {
    const view = await h.run(
      Insights.use((s) => s.saveView("Courses", { measure: "expenses", target: { kind: "category", id: ids.courses }, months: 3, rolling: 0 })),
    )
    const board = await h.run(Dashboards.use((d) => d.create("Suivi")))
    await h.run(
      Dashboards.use((d) =>
        d.save(board.id, {
          widgets: [
            { id: "w1", kind: "insight_view", size: 1, viewId: view.id },
            { id: "w2", kind: "account_balances", size: 1 },
          ],
        }),
      ),
    )
    await h.run(Insights.use((s) => s.deleteView(view.id)))
    const boards = await h.run(Dashboards.use((d) => d.list))
    expect(boards.find((b) => b.id === board.id)!.widgets).toEqual([{ id: "w2", kind: "account_balances", size: 1 }])
  })
})

describe("findings", () => {
  it("produces findings on the demo budget, past the first days of the month", async () => {
    const fresh = await createHarness({ now: "2026-10-20T10:00:00Z" })
    try {
      await fresh.run(Demo.use((d) => d.seed))
      const result = await fresh.run(Insights.use((s) => s.findings))
      expect(result.month).toBe(month)
      expect(result.findings.map((f) => f.kind)).toEqual(["projection", "projection", "top_payees"])
      for (const f of result.findings) {
        expect(f.text.length).toBeGreaterThan(10)
        expect(f.context.length).toBeGreaterThan(0)
      }
    } finally {
      await fresh.dispose()
    }
  })
})

import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runBundleImport } from "~/lib/import-client"
import { backupToBundle, type RunwayBackup } from "~/lib/runway-backup"
import { Categories } from "~/server/services/categories"
import { Dashboards, DEFAULT_WIDGETS, MAIN_DASHBOARD_ID } from "~/server/services/dashboards"
import { Demo } from "~/server/services/demo"
import { ImportExport } from "~/server/services/import-export"
import { Insights } from "~/server/services/insights"
import { Payees } from "~/server/services/payees"
import { Wealth } from "~/server/services/wealth"
import { createHarness, type Harness } from "./harness"

const include = { transactions: true, budgets: true, rules: true, schedules: true }

const api = (h: Harness) => ({
  importStructure: (input: { structure: Parameters<ImportExport["Service"]["importStructure"]>[0]; include: { budgets: boolean; rules: boolean; schedules: boolean } }) =>
    h.run(ImportExport.use((s) => s.importStructure(input.structure, input.include))),
  importTransactions: (input: { rows: Parameters<ImportExport["Service"]["importTransactions"]>[0]; options: Parameters<ImportExport["Service"]["importTransactions"]>[1] }) =>
    h.run(ImportExport.use((s) => s.importTransactions(input.rows, input.options))),
})

const restore = async (h: Harness, backup: RunwayBackup) => {
  const bundle = backupToBundle(backup)
  const result = await runBundleImport(bundle, include, api(h))
  const extras = await h.run(ImportExport.use((s) => s.importExtras(bundle.extras!, result.maps)))
  return { ...result, extras }
}

describe("Runway backup", () => {
  let source: Harness
  let target: Harness
  let backup: RunwayBackup

  beforeAll(async () => {
    source = await createHarness()
    target = await createHarness()
    await source.run(Demo.use((d) => d.seed))
    const tree = await source.run(Categories.use((c) => c.tree))
    const group = tree.find((g) => g.categories.some((c) => c.name === "Courses"))!
    const courses = group.categories.find((c) => c.name === "Courses")!
    const monoprix = (await source.run(Payees.use((p) => p.resolveNames(["Monoprix"])))).get("Monoprix")
    await source.run(
      Insights.use((i) =>
        Effect.all([
          i.saveView("Courses", { measure: "expenses", target: { kind: "category", id: courses.id }, months: 12, rolling: 3 }),
          i.saveView("Groupe", { measure: "expenses", target: { kind: "group", id: group.id }, months: 6, rolling: 0 }),
          i.saveView("Monoprix", { measure: "expenses", target: { kind: "payee", id: monoprix! }, months: 12, rolling: 0 }),
          i.saveView("Tout", { measure: "income", target: { kind: "all" }, months: 12, rolling: 12 }),
        ]),
      ),
    )
    const watch = await source.run(
      Wealth.use((w) =>
        w.create({
          name: "Rolex",
          type: "watch",
          subtitle: null,
          purchase: { amount: 6_800_00, date: "2015-03-10" },
          declared: null,
          retained: "estimated",
          source: { kind: "manual" },
          notes: "Boîte et papiers",
        }),
      ),
    )
    await source.run(Wealth.use((w) => w.addValuation({ assetId: watch, date: "2026-01-15", amount: 9_900_00 })))

    const meta = await source.run(ImportExport.use((s) => s.exportMeta))
    const transactions = await source.run(ImportExport.use((s) => s.exportTransactions(null, 20_000)))
    backup = { ...meta, format: "runway-backup", transactions }
  })
  afterAll(async () => {
    await source?.dispose()
    await target?.dispose()
  })

  it("restores assets, valuations and views, pointing views at the target's ids", async () => {
    // Same categories and payee as the source, under other ids.
    await target.run(Categories.use((c) => c.createStarterSet))
    await target.run(Payees.use((p) => p.resolveNames(["Monoprix"])))
    const { extras } = await restore(target, backup)
    expect(extras).toEqual({ assets: 1, views: 4 })

    const wealth = await target.run(Wealth.use((w) => w.overview))
    expect(wealth.items.find((i) => i.name === "Rolex")).toMatchObject({ value: 9_900_00, notes: "Boîte et papiers" })
    expect(wealth.netWorth).toBe((await source.run(Wealth.use((w) => w.overview))).netWorth)

    const tree = await target.run(Categories.use((c) => c.tree))
    const group = tree.find((g) => g.categories.some((c) => c.name === "Courses"))!
    const courses = group.categories.find((c) => c.name === "Courses")!
    const monoprix = (await target.run(Payees.use((p) => p.resolveNames(["Monoprix"])))).get("Monoprix")
    const views = new Map((await target.run(Insights.use((i) => i.savedViews))).map((v) => [v.name, v.config.target]))
    expect(views.get("Courses")).toEqual({ kind: "category", id: courses.id })
    expect(views.get("Groupe")).toEqual({ kind: "group", id: group.id })
    expect(views.get("Monoprix")).toEqual({ kind: "payee", id: monoprix })
    expect(views.get("Tout")).toEqual({ kind: "all" })
  })

  it("is idempotent", async () => {
    const { extras } = await restore(target, backup)
    expect(extras.views).toBe(0)
    const wealth = await target.run(Wealth.use((w) => w.overview))
    expect(wealth.items.filter((i) => i.name === "Rolex")).toHaveLength(1)
    const watch = wealth.items.find((i) => i.name === "Rolex")!
    expect(await target.run(Wealth.use((w) => w.valuations(watch.id)))).toHaveLength(1)
    expect(await target.run(Insights.use((i) => i.savedViews))).toHaveLength(4)
  })

  it("drops invalid widgets and keeps the default dashboard when restoring dashboards", async () => {
    const fresh = await createHarness()
    try {
      const valid = { id: "ok", kind: "upcoming" as const, size: 1 as const, days: 7 }
      const invalid = { id: "ko", kind: "net_worth" as const, size: 2 as const, months: 7 }
      await restore(fresh, { ...backup, dashboards: [{ id: "perso", name: "Perso", widgets: [valid, invalid], sortOrder: 5 }] })
      const list = await fresh.run(Dashboards.use((d) => d.list))
      expect(list.map((d) => [d.id === MAIN_DASHBOARD_ID ? "main" : d.name, d.widgets])).toEqual([
        ["main", DEFAULT_WIDGETS],
        ["Perso", [valid]],
      ])
    } finally {
      await fresh.dispose()
    }
  })
})

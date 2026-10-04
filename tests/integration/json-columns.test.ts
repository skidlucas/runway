import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Dashboards } from "~/server/services/dashboards"
import { ImportExport } from "~/server/services/import-export"
import { Insights } from "~/server/services/insights"
import { Rules } from "~/server/services/rules"
import { Wealth } from "~/server/services/wealth"
import { createHarness, type Harness } from "./harness"

describe("JSON columns that no longer fit their schema", () => {
  let h: Harness

  beforeAll(async () => {
    h = await createHarness()
    const rule = await h.run(
      Rules.use((r) =>
        r.create({ conditionsOp: "and", conditions: [{ field: "payee", op: "is", value: "Loyer" }], actions: [{ type: "set_notes", notes: "x" }] }),
      ),
    )
    const asset = await h.run(
      Wealth.use((w) =>
        w.create({
          name: "Bitcoin",
          type: "crypto",
          subtitle: null,
          purchase: { amount: 1_000_00, date: "2024-01-10" },
          declared: null,
          retained: "purchase",
          share: 10_000,
          source: { kind: "manual" },
          notes: null,
        }),
      ),
    )
    const view = await h.run(Insights.use((i) => i.saveView("Tout", { measure: "expenses", target: { kind: "all" }, months: 12, rolling: 3 })))
    const board = await h.run(Dashboards.use((d) => d.create("Perso")))
    await h.d1.batch([
      h.d1.prepare("UPDATE rules SET conditions = ? WHERE id = ?").bind(JSON.stringify([{ field: "colour", op: "is", value: "red" }]), rule.id),
      h.d1.prepare("UPDATE assets SET source = ? WHERE id = ?").bind(JSON.stringify({ kind: "gold", grams: 3 }), asset),
      h.d1.prepare("INSERT INTO saved_views (id, name, config, sort_order) VALUES ('old', 'Ancienne', ?, 1)").bind(JSON.stringify({ months: "all" })),
      h.d1
        .prepare("UPDATE dashboards SET widgets = ? WHERE id = ?")
        .bind(JSON.stringify([{ id: "a", kind: "radar", size: 1 }, { id: "b", kind: "upcoming", size: 1, days: 7 }]), board.id),
    ])
    expect(view.id).toBeTruthy()
  })
  afterAll(async () => {
    await h?.dispose()
  })

  it("keep the pages reading them working, with inert fallbacks", async () => {
    const [rule] = await h.run(Rules.use((r) => r.list))
    expect(rule).toMatchObject({ enabled: false, conditions: [], actions: [] })

    const wealth = await h.run(Wealth.use((w) => w.overview))
    expect(wealth.items.find((i) => i.name === "Bitcoin")).toMatchObject({ value: 1_000_00 })

    expect((await h.run(Insights.use((i) => i.savedViews))).map((v) => v.name)).toEqual(["Tout"])

    const board = (await h.run(Dashboards.use((d) => d.list))).find((d) => d.name === "Perso")!
    expect(board.widgets.map((w) => w.id)).toEqual(["b"])
  })

  it("export the fallbacks, so the backup can be restored", async () => {
    const meta = await h.run(ImportExport.use((s) => s.exportMeta))
    expect(meta.assets[0]!.source).toEqual({ kind: "manual" })
    expect(meta.savedViews.map((v) => v.name)).toEqual(["Tout"])
  })
})

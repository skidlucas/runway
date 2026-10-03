import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
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

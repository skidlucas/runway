import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { BundleStructure } from "~/lib/import-bundle"
import { Categories } from "~/server/services/categories"
import { ImportExport, type ImportRow } from "~/server/services/import-export"
import { Rules } from "~/server/services/rules"
import { Schedules } from "~/server/services/schedules"
import { createHarness, type Harness } from "./harness"

// Sizes of a long-lived Actual budget: D1 refuses statements with more than 100 bound
// parameters and Workers cap queries per request, so per-row writes break here.
const GROUPS = 30
const CATEGORIES = 80
const PAYEES = 300
const RULES = 600

const structure: BundleStructure = {
  source: "actual",
  name: "Gros budget",
  accounts: [
    { id: "acc-1", name: "Courant", offBudget: false, closed: false },
    { id: "acc-2", name: "Livret", offBudget: true, closed: false },
  ],
  groups: Array.from({ length: GROUPS }, (_, i) => ({ id: `g-${i}`, name: `Groupe ${i}`, isIncome: i === 0, hidden: false, sortOrder: i })),
  categories: Array.from({ length: CATEGORIES }, (_, i) => ({
    id: `c-${i}`,
    groupId: `g-${i % GROUPS}`,
    name: `Catégorie ${i}`,
    isIncome: i % GROUPS === 0,
    hidden: false,
    sortOrder: i,
  })),
  payees: [
    ...Array.from({ length: PAYEES }, (_, i) => ({ id: `p-${i}`, name: `Marchand ${i}`, transferAccountId: null })),
    { id: "p-t1", name: "Courant", transferAccountId: "acc-1" },
    { id: "p-t2", name: "Livret", transferAccountId: "acc-2" },
  ],
  budgets: Array.from({ length: CATEGORIES }, (_, i) => ({ month: "2026-09", categoryId: `c-${i}`, amount: 1000 * i, carryover: false })),
  buffered: [{ month: "2026-09", amount: 5000 }],
  rules: [
    ...Array.from({ length: RULES }, (_, i) => ({
      conditionsOp: "and" as const,
      conditions: [{ field: "payee" as const, op: "is" as const, value: `Marchand ${i % PAYEES}` }],
      actions: [{ type: "set_category" as const, categoryId: `c-${i % CATEGORIES}` }],
    })),
    // Runway cannot run these: they are skipped instead of failing the import.
    { conditionsOp: "and", conditions: [{ field: "notes", op: "matches", value: "(" }], actions: [{ type: "set_category", categoryId: "c-1" }] },
  ],
  schedules: Array.from({ length: 40 }, (_, i) => ({
    id: `s-${i}`,
    name: `Échéance ${i}`,
    payeeId: `p-${i}`,
    accountId: "acc-1",
    categoryId: `c-${i}`,
    amount: -1000,
    recurrence: { unit: "month", interval: 1 },
    startDate: "2026-01-05",
    nextDate: "2026-11-05",
    endDate: null,
    autoPost: false,
    active: true,
  })),
}

describe("Import at the scale of a real budget", () => {
  let h: Harness

  beforeAll(async () => {
    h = await createHarness()
  }, 60_000)
  afterAll(() => h?.dispose())

  it("imports the structure of a large budget in one go", async () => {
    const maps = await h.run(ImportExport.use((s) => s.importStructure(structure, { budgets: true, rules: true, schedules: true })))
    expect(Object.keys(maps.categories)).toHaveLength(CATEGORIES)
    expect(Object.keys(maps.payees)).toHaveLength(PAYEES + 2)
    expect(maps.payees["p-t1"]).not.toBe(maps.payees["p-t2"])

    const tree = await h.run(Categories.use((c) => c.tree))
    expect(tree.flatMap((g) => g.categories)).toHaveLength(CATEGORIES)
    const rules = await h.run(Rules.use((r) => r.list))
    expect(rules.filter((r) => r.origin === "imported")).toHaveLength(RULES)
    expect(new Set(rules.map((r) => r.sortOrder)).size).toBe(rules.length)
    expect(await h.run(Schedules.use((s) => s.list))).toHaveLength(40)

    // Importing the same budget again matches everything by name instead of duplicating it.
    const again = await h.run(ImportExport.use((s) => s.importStructure(structure, { budgets: true, rules: true, schedules: true })))
    expect(again.categories).toEqual(maps.categories)
    expect(await h.run(Rules.use((r) => r.list))).toHaveLength(rules.length)
  }, 60_000)

  it("categorizes a large bank file from each payee's usual category without a query per row", async () => {
    const tree = await h.run(Categories.use((c) => c.tree))
    const categoryIds = tree.filter((g) => !g.isIncome).flatMap((g) => g.categories.map((c) => c.id))
    const accountId = (await h.run(ImportExport.use((s) => s.exportMeta))).accounts.find((a) => a.name === "Courant")!.id
    const history: ImportRow[] = Array.from({ length: 2_000 }, (_, i) => ({
      accountId,
      date: "2026-08-15",
      amount: -100 - i,
      payeeName: `Habitué ${i % 500}`,
      categoryId: categoryIds[i % 500 % categoryIds.length]!,
    }))
    await h.run(ImportExport.use((s) => s.importTransactions(history, { dedupe: false, applyRules: false })))

    const bankFile: ImportRow[] = Array.from({ length: 4_000 }, (_, i) => ({
      accountId,
      date: "2026-09-20",
      amount: -5_000 - i,
      payeeName: `Habitué ${i % 500}`,
    }))
    const started = performance.now()
    const result = await h.run(ImportExport.use((s) => s.importTransactions(bankFile, { dedupe: true, applyRules: true })))
    const elapsed = performance.now() - started
    expect(result.inserted).toBe(4_000)

    const { results } = await h.d1
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE date = '2026-09-20' AND category_id IS NULL")
      .all<{ n: number }>()
    expect(results[0]!.n).toBe(0)
    // Row by row this took ~20 s locally and blew the per-request query limit in production.
    expect(elapsed).toBeLessThan(5_000)
  }, 60_000)
})

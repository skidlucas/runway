import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addMonths, todayIn } from "~/domain/dates"
import { chunkFamilies } from "~/lib/import-client"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { ForecastService } from "~/server/services/forecast"
import { type ExportCursor, type ExportTransaction, type ImportRow, ImportExport } from "~/server/services/import-export"
import { Insights } from "~/server/services/insights"
import { Payees } from "~/server/services/payees"
import { Transactions } from "~/server/services/transactions"
import { Wealth } from "~/server/services/wealth"
import { createHarness, type Harness, timeBudget } from "./harness"

// 100 000 operations over three years: the volume of a long Actual history. Timings are loose
// bounds against regressions to row-by-row work, not benchmarks.
const ROWS = 100_000
const month = todayIn("Europe/Paris").slice(0, 7)

describe("Volume", () => {
  let h: Harness
  let rows: ImportRow[]
  let account: string

  beforeAll(async () => {
    h = await createHarness()
    await h.run(Categories.use((c) => c.createStarterSet))
    const tree = await h.run(Categories.use((c) => c.tree))
    const categoryIds = tree.filter((g) => !g.isIncome).flatMap((g) => g.categories.map((c) => c.id))
    account = await h.run(
      Accounts.use((a) => a.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 0, startingDate: `${addMonths(month, -36)}-01` })),
    )
    const payees = [...(await h.run(Payees.use((p) => p.resolveNames(Array.from({ length: 500 }, (_, i) => `Marchand ${i}`))))).values()]
    rows = Array.from({ length: ROWS }, (_, i) => {
      const m = addMonths(month, -35 + (i % 36))
      return {
        id: `vol-${i}`,
        accountId: account,
        date: `${m}-${String(1 + (i % 28)).padStart(2, "0")}`,
        amount: -(100 + (i % 9_000)),
        payeeId: payees[i % payees.length]!,
        categoryId: categoryIds[i % categoryIds.length]!,
      }
    })
  }, 60_000)
  afterAll(() => h?.dispose())

  it("imports 100 000 operations in chunks, then finds them all as duplicates", async () => {
    const chunks = chunkFamilies(rows)
    let started = performance.now()
    let inserted = 0
    for (const chunk of chunks) {
      inserted += (await h.run(ImportExport.use((s) => s.importTransactions(chunk, { dedupe: true, applyRules: false })))).inserted
    }
    const importMs = performance.now() - started
    expect(inserted).toBe(ROWS)

    started = performance.now()
    const again = await h.run(ImportExport.use((s) => s.importTransactions(chunks[0]!, { dedupe: true, applyRules: false })))
    expect(again).toEqual({ inserted: 0, skipped: 0, duplicates: chunks[0]!.length })
    console.info(`import ${ROWS} rows: ${Math.round(importMs)} ms (${chunks.length} chunks) · re-import chunk: ${Math.round(performance.now() - started)} ms`)
    expect(importMs).toBeLessThan(timeBudget(60_000))
  }, timeBudget(120_000))

  it("keeps the main screens fast on that history", async () => {
    const timings: Record<string, number> = {}
    const time = async <A>(name: string, run: () => Promise<A>) => {
      const started = performance.now()
      const result = await run()
      timings[name] = Math.round(performance.now() - started)
      return result
    }
    const budget = await time("budget", () => h.run(Budget.use((b) => b.month(month))))
    expect(budget.spent).toBeGreaterThan(0)
    await time("forecast", () => h.run(ForecastService.use((f) => f.month())))
    await time("insights", () => h.run(Insights.use((i) => i.view({ measure: "expenses", target: { kind: "all" }, months: 12, rolling: 6 }))))
    await time("findings", () => h.run(Insights.use((i) => i.findings)))
    await time("wealth", () => h.run(Wealth.use((w) => w.overview)))
    const register = await time("register", () => h.run(Transactions.use((t) => t.list({ accountId: account, limit: 200 }))))
    const accounts = await h.run(Accounts.use((a) => a.list))
    expect(register.rows[0]!.balance).toBe(accounts.find((a) => a.id === account)!.balance)
    const last = register.rows.at(-1)!
    expect(register.rows.at(-2)!.balance! - register.rows.at(-2)!.amount).toBe(last.balance)
    await time("register next page", () => h.run(Transactions.use((t) => t.list({ accountId: account, limit: 200, after: register.next! }))))
    const exported = await time("export", async () => {
      let count = 0
      for (let cursor: ExportCursor | null = null; ; ) {
        const page: ExportTransaction[] = await h.run(ImportExport.use((s) => s.exportTransactions(cursor, 20_000)))
        count += page.length
        if (page.length < 20_000) return count
        cursor = page.at(-1)!
      }
    })
    expect(exported).toBe(ROWS)
    console.info("timings (ms)", timings)
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(timeBudget(name === "export" ? 20_000 : 5_000))
  }, timeBudget(120_000))
})

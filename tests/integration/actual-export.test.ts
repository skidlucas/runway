import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as actual from "@actual-app/api"
import { unzipSync } from "fflate"
import initSqlJs from "sql.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildActualExport } from "~/lib/actual/export"
import { parseActual, unzipActual } from "~/lib/actual/parse"
import { runBundleImport } from "~/lib/import-client"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { type ExportMeta, type ExportTransaction, ImportExport } from "~/server/services/import-export"
import { Rules } from "~/server/services/rules"
import { createHarness, type Harness, importApi } from "./harness"

type ActualCategory = { id: string; name: string; is_income: boolean; budgeted?: number; spent?: number; balance?: number; received?: number }
type ActualMonth = { toBudget: number; totalIncome: number; categoryGroups: Array<{ categories: ActualCategory[] }> }

const fixture = join(process.cwd(), "tests/fixtures")
let h: Harness
let dataDir: string
let meta: ExportMeta
let transactions: ExportTransaction[]
let skippedRules: number
let budgetId: string

beforeAll(async () => {
  h = await createHarness({ now: "2026-10-04T10:00:00Z" })
  dataDir = mkdtempSync(join(tmpdir(), "runway-actual-export-"))
  const SQL = await initSqlJs()
  const bundle = parseActual(SQL, unzipActual(new Uint8Array(readFileSync(join(fixture, "actual-fixture.zip")))))
  await runBundleImport(bundle, { transactions: true, budgets: true, rules: true, schedules: true }, importApi(h))
  // Actual compares signed amounts where Runway compares absolute ones: this rule cannot be exported.
  const groceries = (await h.run(Categories.use((c) => c.tree))).flatMap((g) => g.categories).find((c) => c.name === "Courses")!
  await h.run(
    Rules.use((r) =>
      r.create({ conditionsOp: "and", conditions: [{ field: "amount", op: "gt", value: 50_000 }], actions: [{ type: "set_category", categoryId: groceries.id }] }),
    ),
  )

  meta = await h.run(ImportExport.use((s) => s.exportMeta))
  transactions = await h.run(ImportExport.use((s) => s.exportTransactions(null, 20_000)))
  const template = new Uint8Array(readFileSync(join(process.cwd(), "public/actual-template.sqlite")))
  const built = buildActualExport(SQL, template, meta, transactions, "Export test")
  skippedRules = built.skippedRules

  const files = unzipSync(built.zip)
  const metadata = JSON.parse(new TextDecoder().decode(files["metadata.json"]))
  budgetId = metadata.id
  const dir = join(dataDir, budgetId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "db.sqlite"), files["db.sqlite"]!)
  writeFileSync(join(dir, "metadata.json"), files["metadata.json"]!)
  await actual.init({ dataDir })
  await actual.loadBudget(budgetId)
}, 120_000)
afterAll(async () => {
  await actual.shutdown().catch(() => {})
  await h?.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

describe("Actual export, read back by the official Actual API", () => {
  it("exports every transaction", () => {
    expect(transactions).toHaveLength(meta.transactionCount)
  })

  it("keeps every account and its balance", async () => {
    const accounts = (await actual.getAccounts()) as Array<{ id: string; name: string; offbudget: boolean; closed: boolean }>
    expect(accounts.map((a) => [a.name, a.offbudget, a.closed]).sort()).toEqual(meta.accounts.map((a) => [a.name, a.offBudget, a.closed]).sort())
    for (const a of accounts) {
      const list = (await actual.getTransactions(a.id, "2000-01-01", "2100-01-01")) as Array<{ amount: number }>
      const expected = transactions.filter((t) => t.accountId === a.id && !t.parentId).reduce((s, t) => s + t.amount, 0)
      expect(list.reduce((s, t) => s + t.amount, 0), a.name).toBe(expected)
    }
  })

  it("gives the same to budget and the same budgeted, spent and balance for every category, every month", async () => {
    const months = (await actual.getBudgetMonths()) as string[]
    const first = [...transactions.map((t) => t.date.slice(0, 7)), ...meta.budgets.map((b) => b.month)].sort()[0]!
    expect(months[0]! <= first).toBe(true)
    expect(months.length).toBeGreaterThan(6)
    for (const month of months) {
      const theirs = (await actual.getBudgetMonth(month)) as unknown as ActualMonth
      const mine = await h.run(Budget.use((b) => b.month(month)))
      expect(theirs.toBudget, `${month} à budgéter`).toBe(mine.toBudget)
      expect(theirs.totalIncome, `${month} revenus`).toBe(mine.income)
      const ours = new Map(mine.groups.flatMap((g) => g.categories.map((c) => [c.id, c] as const)))
      const their = theirs.categoryGroups.flatMap((g) => g.categories)
      expect(their.map((c) => c.id).sort(), month).toEqual([...ours.keys()].sort())
      for (const c of their) {
        const row = ours.get(c.id)!
        if (c.is_income) {
          expect(c.received, `${month} ${c.name} reçu`).toBe(row.spent)
          continue
        }
        expect(c.budgeted, `${month} ${c.name} budgété`).toBe(row.budgeted)
        expect(c.spent, `${month} ${c.name} dépensé`).toBe(-row.spent)
        expect(c.balance, `${month} ${c.name} solde`).toBe(row.available)
      }
    }
  })

  it("exports every rule it can translate and reports the amount rules it leaves out", async () => {
    expect(skippedRules).toBe(1)
    const rules = (await actual.getRules()) as Array<{ actions: Array<{ op: string }> }>
    const scheduleRules = rules.filter((r) => r.actions.some((a) => a.op === "link-schedule"))
    expect(scheduleRules).toHaveLength(meta.schedules.length)
    expect(rules.length - scheduleRules.length).toBe(meta.rules.length - skippedRules)
  })

  it("keeps every schedule with its next date, whether it posts by itself and whether it ended", async () => {
    const schedules = (await actual.getSchedules()) as Array<{ name: string; next_date: string; posts_transaction: boolean; completed: boolean }>
    expect(schedules.map((s) => [s.name, s.next_date, s.posts_transaction, s.completed]).sort()).toEqual(
      meta.schedules.map((s) => [s.name, s.nextDate, s.autoPost, !s.active]).sort(),
    )
  })
})

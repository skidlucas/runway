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
import { ImportExport } from "~/server/services/import-export"
import { createHarness, type Harness } from "./harness"

const fixture = join(process.cwd(), "tests/fixtures")
let h: Harness
let dataDir: string

beforeAll(async () => {
  h = await createHarness()
  dataDir = mkdtempSync(join(tmpdir(), "runway-actual-export-"))
})
afterAll(async () => {
  await h?.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

describe("Actual export", () => {
  it("produces a zip that the official Actual API loads with the same numbers", async () => {
    const SQL = await initSqlJs()
    const bundle = parseActual(SQL, unzipActual(new Uint8Array(readFileSync(join(fixture, "actual-fixture.zip")))))
    await runBundleImport(bundle, { transactions: true, budgets: true, rules: true, schedules: true }, {
      importStructure: (i) => h.run(ImportExport.use((s) => s.importStructure(i.structure, i.include))),
      importTransactions: (i) => h.run(ImportExport.use((s) => s.importTransactions(i.rows, i.options))),
    })

    const meta = await h.run(ImportExport.use((s) => s.exportMeta))
    const transactions = await h.run(ImportExport.use((s) => s.exportTransactions(0, 20_000)))
    expect(transactions).toHaveLength(meta.transactionCount)
    const template = new Uint8Array(readFileSync(join(process.cwd(), "public/actual-template.sqlite")))
    const { zip, skippedRules } = buildActualExport(SQL, template, meta, transactions, "Export test")
    expect(skippedRules).toBe(0)

    const files = unzipSync(zip)
    const metadata = JSON.parse(new TextDecoder().decode(files["metadata.json"]))
    const dir = join(dataDir, metadata.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "db.sqlite"), files["db.sqlite"]!)
    writeFileSync(join(dir, "metadata.json"), files["metadata.json"]!)

    await actual.init({ dataDir })
    try {
      await actual.loadBudget(metadata.id)
      const accounts = await actual.getAccounts()
      const ours = await h.run(ImportExport.use((s) => s.exportMeta))
      expect(accounts.map((a: { name: string }) => a.name).sort()).toEqual(ours.accounts.map((a) => a.name).sort())
      for (const a of accounts as Array<{ id: string; name: string }>) {
        const list = await actual.getTransactions(a.id, "2000-01-01", "2100-01-01")
        const balance = list.reduce((s: number, t: { amount: number }) => s + t.amount, 0)
        const expected = transactions.filter((t) => t.accountId === a.id && !t.parentId).reduce((s, t) => s + t.amount, 0)
        expect(balance, a.name).toBe(expected)
      }
      for (const month of ["2026-05", "2026-08", "2026-10"]) {
        const theirs = await actual.getBudgetMonth(month)
        const mine = await h.run(Budget.use((b) => b.month(month)))
        expect(theirs.toBudget, month).toBe(mine.toBudget)
      }
      const rules = await actual.getRules()
      expect(rules.length).toBeGreaterThanOrEqual(2)
      const schedules = await actual.getSchedules()
      expect(schedules.map((s) => s.name)).toContain("Netflix")
    } finally {
      await actual.shutdown()
    }
  }, 120_000)
})

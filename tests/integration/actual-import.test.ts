import { readFileSync } from "node:fs"
import { join } from "node:path"
import initSqlJs from "sql.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseActual, unzipActual } from "~/lib/actual/parse"
import type { ImportBundle } from "~/lib/import-bundle"
import { chunkFamilies, runBundleImport } from "~/lib/import-client"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { ImportExport } from "~/server/services/import-export"
import { Rules } from "~/server/services/rules"
import { Schedules } from "~/server/services/schedules"
import { createHarness, type Harness, importApi, tableCounts } from "./harness"

type Expected = {
  accounts: Record<string, { balance: number; offBudget: boolean; count: number }>
  months: Record<string, { toBudget: number; totalIncome: number; categories: Record<string, { budgeted: number; spent: number; balance: number }> }>
}

const fixture = join(process.cwd(), "tests/fixtures")
const expected = JSON.parse(readFileSync(join(fixture, "actual-expected.json"), "utf8")) as Expected

const NOW = "2026-10-04T10:00:00Z"
const include = { transactions: true, budgets: true, rules: true, schedules: true }

let h: Harness
let bundle: ImportBundle
let imported: Awaited<ReturnType<typeof runBundleImport>>

beforeAll(async () => {
  const SQL = await initSqlJs()
  bundle = parseActual(SQL, unzipActual(new Uint8Array(readFileSync(join(fixture, "actual-fixture.zip")))))
  h = await createHarness({ now: NOW })
  imported = await runBundleImport(bundle, include, importApi(h))
}, 60_000)
afterAll(async () => {
  await h?.dispose()
})

describe("Actual parsing", () => {
  it("parses the export: tombstones, merged payees, splits and transfers", () => {
    expect(bundle.name).toBe("Fixture Perso")
    expect(bundle.accounts.map((a) => a.name).sort()).toEqual(["Carte de crédit", "Compte courant", "Livret A"])
    // The deleted transaction is gone, and "Monop'" was merged into "Monoprix".
    expect(bundle.transactions.some((t) => t.amount === -9999)).toBe(false)
    expect(bundle.payees.some((p) => p.name === "Monop'")).toBe(false)
    expect(bundle.transactions.filter((t) => t.isParent)).toHaveLength(7)
    expect(bundle.transactions.filter((t) => t.transferId).length).toBe(4)
    expect(bundle.rules).toHaveLength(2)
    expect(bundle.schedules).toHaveLength(1)
    expect(bundle.schedules[0]).toMatchObject({ name: "Netflix", amount: -1349, recurrence: { unit: "month", interval: 1 } })
  })

  it("moves a schedule past an occurrence Actual already posted but did not advance", async () => {
    const SQL = await initSqlJs()
    const file = unzipActual(new Uint8Array(readFileSync(join(fixture, "actual-fixture.zip"))))
    const db = new SQL.Database(file.db)
    const id = String(db.exec("SELECT id FROM schedules WHERE tombstone = 0 LIMIT 1")[0]!.values[0]![0])
    db.run("UPDATE schedules_next_date SET local_next_date = 20261003, base_next_date = 20261003, local_next_date_ts = 1, base_next_date_ts = 1 WHERE schedule_id = ?", [id])
    db.run("UPDATE transactions SET schedule = ?, date = 20261003 WHERE id = (SELECT id FROM transactions WHERE tombstone = 0 AND isChild = 0 LIMIT 1)", [id])
    const parsed = parseActual(SQL, { ...file, db: db.export() })
    const schedule = parsed.schedules.find((s) => s.id === id)!
    expect(schedule.nextDate > "2026-10-03").toBe(true)
    expect(schedule.active).toBe(true)
  })

  it("drops the name Actual generates for a schedule made from a future transaction", async () => {
    const SQL = await initSqlJs()
    const file = unzipActual(new Uint8Array(readFileSync(join(fixture, "actual-fixture.zip"))))
    const db = new SQL.Database(file.db)
    const id = String(db.exec("SELECT id FROM schedules WHERE tombstone = 0 LIMIT 1")[0]!.values[0]![0])
    db.run("UPDATE schedules SET name = 'Auto-created future transaction (Oct 05, 2026) - 1787553522890' WHERE id = ?", [id])
    const parsed = parseActual(SQL, { ...file, db: db.export() })
    expect(parsed.schedules.find((s) => s.id === id)?.name).toBeNull()
  })

  it("does not take the late payment of the previous occurrence for the next one", async () => {
    const SQL = await initSqlJs()
    const file = unzipActual(new Uint8Array(readFileSync(join(fixture, "actual-fixture.zip"))))
    const db = new SQL.Database(file.db)
    const id = String(db.exec("SELECT id FROM schedules WHERE tombstone = 0 LIMIT 1")[0]!.values[0]![0])
    db.run("UPDATE schedules_next_date SET local_next_date = 20261003, base_next_date = 20261003, local_next_date_ts = 1, base_next_date_ts = 1 WHERE schedule_id = ?", [id])
    db.run("UPDATE transactions SET schedule = ?, date = 20260926 WHERE id = (SELECT id FROM transactions WHERE tombstone = 0 AND isChild = 0 LIMIT 1)", [id])
    const parsed = parseActual(SQL, { ...file, db: db.export() })
    expect(parsed.schedules.find((s) => s.id === id)?.nextDate).toBe("2026-10-03")
  })

  it("keeps split families together when chunking", () => {
    const rows = bundle.transactions.map((t) => ({ ...t, accountId: t.accountId }))
    const chunks = chunkFamilies(rows, 5)
    for (const chunk of chunks) {
      const ids = new Set(chunk.map((r) => r.id))
      for (const r of chunk) if (r.parentId) expect(ids.has(r.parentId)).toBe(true)
    }
    expect(chunks.flat()).toHaveLength(rows.length)
  })

  it("never cuts a day in two when chunking", () => {
    const row = (id: string, date: string) => ({ id, accountId: "a", date, amount: -150 })
    const chunks = chunkFamilies([row("1", "2026-01-01"), row("2", "2026-01-02"), row("3", "2026-01-02"), row("4", "2026-01-03")], 2)
    expect(chunks.map((c) => c.map((r) => r.id))).toEqual([["1", "2", "3"], ["4"]])
  })

})

describe("Actual import", () => {
  it("imports and reproduces Actual's balances", async () => {
    expect(imported.duplicates).toBe(0)
    const accounts = await h.run(Accounts.use((a) => a.list))
    for (const [name, exp] of Object.entries(expected.accounts)) {
      const acc = accounts.find((a) => a.name === name)
      expect(acc, name).toBeDefined()
      expect(acc?.balance, name).toBe(exp.balance)
      expect(acc?.offBudget, name).toBe(exp.offBudget)
    }
  })

  it("keeps Actual's order of the operations of a same day", async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database(unzipActual(new Uint8Array(readFileSync(join(fixture, "actual-fixture.zip")))).db)
    const source = (db.exec(
      "SELECT acct || date, id FROM transactions WHERE tombstone = 0 AND isChild = 0 ORDER BY acct, date, sort_order DESC",
    )[0]?.values ?? []) as Array<[string, string]>
    const days = new Map<string, string[]>()
    for (const [day, id] of source) days.set(day, [...(days.get(day) ?? []), id])
    const sameDay = [...days.values()].filter((ids) => ids.length > 1)
    expect(sameDay.length).toBeGreaterThan(0)
    const { results } = await h.d1
      .prepare("SELECT id FROM transactions WHERE parent_id IS NULL ORDER BY date DESC, created_at DESC, id DESC")
      .all<{ id: string }>()
    const rank = new Map(results.map((r, i) => [r.id, i]))
    expect(sameDay.flat().every((id) => rank.has(id))).toBe(true)
    for (const ids of sameDay) expect([...ids].sort((a, b) => rank.get(a)! - rank.get(b)!)).toEqual(ids)
  })

  it("reproduces Actual's budget month by month (to budget, carryover, overspending)", async () => {
    for (const [month, exp] of Object.entries(expected.months)) {
      const got = await h.run(Budget.use((b) => b.month(month)))
      expect(got.toBudget, `${month} toBudget`).toBe(exp.toBudget)
      expect(got.income, `${month} income`).toBe(exp.totalIncome)
      const cats = new Map(got.groups.flatMap((g) => g.categories.map((c) => [c.name, c] as const)))
      for (const [name, c] of Object.entries(exp.categories)) {
        const mine = cats.get(name)
        expect(mine, `${month} ${name}`).toBeDefined()
        // Actual's income rows hold no budgeted, spent or balance: the month's income is checked above.
        if (mine!.isIncome) continue
        expect(mine!.budgeted, `${month} ${name} budgeted`).toBe(c.budgeted)
        expect(-mine!.spent, `${month} ${name} spent`).toBe(c.spent)
        expect(mine!.available, `${month} ${name} balance`).toBe(c.balance)
      }
    }
  })

  it("imports rules and schedules", async () => {
    const rules = await h.run(Rules.use((r) => r.list))
    expect(rules).toHaveLength(2)
    expect(rules.every((r) => r.origin === "imported")).toBe(true)
    const schedules = await h.run(Schedules.use((s) => s.list))
    expect(schedules.map((s) => s.name)).toEqual(["Netflix"])
  })

  it("is idempotent: a second import inserts nothing", async () => {
    const before = (await h.run(Accounts.use((a) => a.list))).reduce((s, a) => s + a.transactionCount, 0)
    const again = await runBundleImport(bundle, include, importApi(h))
    expect(again.inserted).toBe(0)
    expect(again.duplicates).toBeGreaterThan(0)
    const after = (await h.run(Accounts.use((a) => a.list))).reduce((s, a) => s + a.transactionCount, 0)
    expect(after).toBe(before)
    expect((await h.run(Rules.use((r) => r.list))).length).toBe(2)
  })

  it("counts duplicates for the preview", async () => {
    const probes = bundle.transactions
      .filter((t) => !t.parentId)
      .slice(0, 10)
      .map((t) => ({
        account: bundle.accounts.find((a) => a.id === t.accountId)!.name,
        date: t.date,
        amount: t.amount,
        payee: bundle.payees.find((p) => p.id === t.payeeId)?.name ?? null,
        importedId: t.importedId,
        importedPayee: t.importedPayee,
      }))
    expect(await h.run(ImportExport.use((s) => s.countDuplicates(probes)))).toBe(10)
  })

})

describe("Wiping an imported budget", () => {
  it("leaves no user data behind", async () => {
    const fresh = await createHarness({ now: NOW })
    try {
      await runBundleImport(bundle, include, importApi(fresh))
      expect((await tableCounts(fresh.d1)).transactions).toBeGreaterThan(0)
      await fresh.run(ImportExport.use((s) => s.wipe))
      expect(Object.entries(await tableCounts(fresh.d1)).filter(([, n]) => n > 0)).toEqual([])
    } finally {
      await fresh.dispose()
    }
  })
})

describe("Actual parsing of edge cases", () => {
  const template = () => readFileSync(join(process.cwd(), "public/actual-template.sqlite"))

  it("turns a transfer inside a split into plain operations, reads signed amount thresholds and ends after N payments", async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database(template())
    db.run("INSERT INTO accounts (id, name, offbudget, closed, tombstone, sort_order) VALUES ('A','Courant',0,0,0,1),('B','Livret',0,0,0,2)")
    db.run("INSERT INTO payees (id, name, transfer_acct, tombstone) VALUES ('PA','','A',0),('PB','','B',0)")
    db.run("INSERT INTO category_groups (id, name, is_income, sort_order, tombstone) VALUES ('G','Dépenses',0,1,0)")
    db.run("INSERT INTO categories (id, name, is_income, cat_group, sort_order, tombstone) VALUES ('C1','Frais',0,'G',1,0)")
    db.run(`INSERT INTO transactions (id,isParent,isChild,parent_id,acct,category,amount,description,date,sort_order,tombstone,transferred_id)
            VALUES ('P',1,0,NULL,'A',NULL,-10000,NULL,20260915,3,0,NULL),
                   ('K1',0,1,'P','A',NULL,-6000,'PB',20260915,2,0,'M'),
                   ('K2',0,1,'P','A','C1',-4000,NULL,20260915,1,0,NULL),
                   ('M',0,0,NULL,'B',NULL,6000,'PA',20260915,1,0,'K1')`)
    const amountRule = (id: string, op: string, value: number) =>
      db.run("INSERT INTO rules (id, stage, conditions, actions, conditions_op, tombstone) VALUES (?,NULL,?,?,'and',0)", [
        id,
        JSON.stringify([{ field: "amount", op, value, type: "number" }]),
        JSON.stringify([{ op: "set", field: "category", value: "C1", type: "id" }]),
      ])
    amountRule("R1", "lt", -50000)
    amountRule("R2", "gte", 1000)
    db.run("INSERT INTO rules (id, stage, conditions, actions, conditions_op, tombstone) VALUES ('SR',NULL,?,?,'and',0)", [
      JSON.stringify([
        { field: "account", op: "is", value: "A" },
        { field: "amount", op: "isapprox", value: -30000 },
        { field: "date", op: "isapprox", value: { start: "2026-01-15", frequency: "monthly", interval: 1, endMode: "after_n_occurrences", endOccurrences: 12, endDate: "2026-01-15" } },
      ]),
      JSON.stringify([{ op: "link-schedule", value: "S1" }]),
    ])
    db.run("INSERT INTO schedules (id, rule, active, completed, posts_transaction, tombstone, name) VALUES ('S1','SR',1,0,0,0,'Crédit auto')")

    const parsed = parseActual(SQL, { db: db.export(), metadata: { budgetName: "edge" } })
    const tx = new Map(parsed.transactions.map((t) => [t.id, t]))
    expect(tx.get("K1")?.transferId).toBeNull()
    expect(tx.get("M")).toMatchObject({ transferId: null, payeeId: null, amount: 6000 })
    expect(parsed.rules.map((r) => r.conditions[0])).toEqual([
      { field: "amount", op: "gt", value: 50000 },
      { field: "amount", op: "gt", value: 999 },
    ])
    expect(parsed.schedules[0]?.endDate).toBe("2026-12-15")
  })
})

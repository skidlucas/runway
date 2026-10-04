import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { ImportExport } from "~/server/services/import-export"
import { Payees } from "~/server/services/payees"
import { Rules } from "~/server/services/rules"
import { Settings } from "~/server/services/settings"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

const NOW = "2026-10-04T10:00:00Z"

let h: Harness
const ids = { checking: "", savings: "", courses: "", transport: "", restaurants: "", outings: "", daily: "" }
let accounts = 0

const openAccount = (startingBalance: number, startingDate = "2026-10-01") =>
  h.run(Accounts.use((a) => a.create({ name: `Compte ${++accounts}`, kind: "checking", offBudget: false, startingBalance, startingDate })))
const categoryRow = async (month: string, id: string) =>
  (await h.run(Budget.use((b) => b.month(month)))).groups.flatMap((g) => g.categories).find((c) => c.id === id)!

beforeAll(async () => {
  h = await createHarness({ now: NOW })
  await h.run(Categories.use((c) => c.createStarterSet))
  const tree = await h.run(Categories.use((c) => c.tree))
  const cat = (name: string) => tree.flatMap((g) => g.categories).find((c) => c.name === name)!.id
  ids.courses = cat("Courses")
  ids.transport = cat("Transport")
  ids.restaurants = cat("Restaurants")
  ids.outings = cat("Sorties")
  ids.daily = tree.find((g) => g.name === "Quotidien")!.id
  ids.checking = await h.run(
    Accounts.use((a) => a.create({ name: "Compte courant", kind: "checking", offBudget: false, startingBalance: 100000, startingDate: "2026-09-01" })),
  )
  ids.savings = await h.run(
    Accounts.use((a) => a.create({ name: "Livret A", kind: "savings", offBudget: true, startingBalance: 840000, startingDate: "2026-09-01" })),
  )
}, 60_000)
afterAll(async () => {
  await h?.dispose()
})

describe("core flows on D1", () => {
  it("creates starter categories and accounts with starting balances", async () => {
    const tree = await h.run(Categories.use((c) => c.tree))
    expect(tree.map((g) => g.name)).toEqual(["Logement", "Quotidien", "Loisirs", "Épargne", "Revenus"])
    const { results } = await h.d1
      .prepare("SELECT account_id AS accountId, amount, date FROM transactions WHERE starting_balance = 1 AND account_id IN (?, ?) ORDER BY amount")
      .bind(ids.checking, ids.savings)
      .all()
    expect(results).toEqual([
      { accountId: ids.checking, amount: 100000, date: "2026-09-01" },
      { accountId: ids.savings, amount: 840000, date: "2026-09-01" },
    ])
  })

  it("counts the starting balance of a budget account as income in the budget", async () => {
    const month = await h.run(Budget.use((b) => b.month("2026-09")))
    expect(month.income).toBe(100000)
    expect(month.toBudget).toBe(100000 - month.budgeted)
  })

  it("budgets, spends, and carries over", async () => {
    const toBudget = async (month: string) => (await h.run(Budget.use((b) => b.month(month)))).toBudget
    const [novemberBefore, decemberBefore] = [await toBudget("2026-11"), await toBudget("2026-12")]
    await h.run(Budget.use((b) => b.setAmount("2026-11", ids.restaurants, 40000)))
    await h.run(
      Transactions.use((t) =>
        t.create({ accountId: ids.checking, date: "2026-11-10", amount: -4218, payee: { kind: "name", name: "Bistrot" }, categoryId: ids.restaurants }),
      ),
    )
    expect(await categoryRow("2026-11", ids.restaurants)).toMatchObject({ budgeted: 40000, spent: 4218, available: 35782 })
    expect(await toBudget("2026-11")).toBe(novemberBefore - 40000)
    expect((await categoryRow("2026-12", ids.restaurants)).available).toBe(35782)
    expect(await toBudget("2026-12")).toBe(decemberBefore - 40000)
  })

  it("learns the category of a payee and applies rules", async () => {
    const add = (input: { date: string; amount: number; payee: string; categoryId?: string; importedPayee?: string }) =>
      h.run(
        Transactions.use((t) =>
          t.create({
            accountId: ids.checking,
            date: input.date,
            amount: input.amount,
            payee: { kind: "name", name: input.payee },
            categoryId: input.categoryId,
            importedPayee: input.importedPayee,
          }),
        ),
      )
    await add({ date: "2026-10-01", amount: -1500, payee: "Cinéma", categoryId: ids.outings })
    const learned = await add({ date: "2026-10-02", amount: -1999, payee: "cinéma" })
    expect((await h.run(Transactions.use((t) => t.get(learned)))).categoryId).toBe(ids.outings)

    await h.run(
      Rules.use((r) =>
        r.create({
          conditionsOp: "and",
          conditions: [{ field: "imported_payee", op: "contains", value: "total" }],
          actions: [{ type: "set_category", categoryId: ids.transport }],
        }),
      ),
    )
    const ruled = await add({ date: "2026-10-03", amount: -5830, payee: "TotalEnergies", importedPayee: "CB TOTAL ENERGIES 03/10" })
    expect((await h.run(Transactions.use((t) => t.get(ruled)))).categoryId).toBe(ids.transport)
  })

  it("creates transfers with a linked mirror and keeps them in sync", async () => {
    const savingsBalance = async () => (await h.run(Accounts.use((a) => a.list))).find((a) => a.id === ids.savings)!.balance
    const before = await savingsBalance()
    const id = await h.run(
      Transactions.use((t) =>
        t.create({ accountId: ids.checking, date: "2026-10-04", amount: -20000, payee: { kind: "transfer", accountId: ids.savings }, categoryId: ids.courses }),
      ),
    )
    const tx = await h.run(Transactions.use((t) => t.get(id)))
    // On-budget → off-budget keeps its category: the money leaves the budget.
    expect(tx.categoryId).toBe(ids.courses)
    expect(tx.transferAccountId).toBe(ids.savings)
    const mirror = await h.run(Transactions.use((t) => t.get(tx.transferId!)))
    expect(mirror).toMatchObject({ amount: 20000, accountId: ids.savings, categoryId: null, transferAccountId: ids.checking })

    await h.run(Transactions.use((t) => t.update(id, { amount: -25000 })))
    expect((await h.run(Transactions.use((t) => t.get(tx.transferId!)))).amount).toBe(25000)
    expect(await savingsBalance()).toBe(before + 25000)

    await h.run(Transactions.use((t) => t.remove([id])))
    expect(await savingsBalance()).toBe(before)
  })

  it("splits a transaction across categories", async () => {
    const account = await openAccount(100000)
    const coursesBefore = (await categoryRow("2026-10", ids.courses)).spent
    const transportBefore = (await categoryRow("2026-10", ids.transport)).spent
    const id = await h.run(
      Transactions.use((t) =>
        t.create({
          accountId: account,
          date: "2026-10-05",
          amount: -10000,
          payee: { kind: "name", name: "Carrefour" },
          splits: [
            { amount: -6000, categoryId: ids.courses },
            { amount: -4000, categoryId: ids.transport },
          ],
        }),
      ),
    )
    const page = await h.run(Transactions.use((t) => t.list({ accountId: account })))
    expect(page.rows.map((r) => [r.id === id, r.isParent, r.balance])).toEqual([
      [true, true, 90000],
      [false, false, 100000],
    ])
    expect(page.children[id]?.map((c) => c.amount)).toEqual([-6000, -4000])
    expect((await categoryRow("2026-10", ids.courses)).spent).toBe(coursesBefore + 6000)
    expect((await categoryRow("2026-10", ids.transport)).spent).toBe(transportBefore + 4000)
  })

  it("counts the register only on its first page and carries the balance across pages", async () => {
    const account = await openAccount(10000)
    for (const [day, amount] of [["02", -100], ["03", -200], ["04", -300], ["05", -400]] as const) {
      await h.run(Transactions.use((t) => t.create({ accountId: account, date: `2026-10-${day}`, amount, payee: { kind: "none" }, categoryId: null })))
    }
    const first = await h.run(Transactions.use((t) => t.list({ accountId: account, limit: 2 })))
    const next = await h.run(Transactions.use((t) => t.list({ accountId: account, limit: 2, after: first.next! })))
    expect(first.total).toBe(5)
    expect(first.rows.map((r) => r.balance)).toEqual([9000, 9400])
    expect(next.total).toBeNull()
    expect(next.rows.map((r) => r.balance)).toEqual([9700, 9900])
  })

  it("pages through a register in the same order and with the same balances as one long page", async () => {
    for (const filter of [{ accountId: ids.checking }, {}, { categoryId: ids.courses }]) {
      const whole = await h.run(Transactions.use((t) => t.list({ ...filter, limit: 1000 })))
      const paged: typeof whole.rows = []
      for (let after = undefined as (typeof whole)["next"] | undefined; ; ) {
        const page: typeof whole = await h.run(Transactions.use((t) => t.list({ ...filter, limit: 2, ...(after ? { after } : {}) })))
        paged.push(...page.rows)
        if (!page.next) break
        after = page.next
      }
      expect(paged.map((r) => [r.id, r.balance])).toEqual(whole.rows.map((r) => [r.id, r.balance]))
    }
  })

  it("lists payee names with their last category, as the full payee list does", async () => {
    const full = await h.run(Payees.use((p) => p.list))
    const names = await h.run(Payees.use((p) => p.names))
    expect(names).toEqual(full.map(({ id, name, transferAccountId, lastCategoryId }) => ({ id, name, transferAccountId, lastCategoryId })))
    expect(names.some((p) => p.lastCategoryId !== null)).toBe(true)
  })

  it("reconciles an account and books the difference", async () => {
    const account = await openAccount(50000)
    await h.run(Transactions.use((t) => t.create({ accountId: account, date: "2026-10-02", amount: -1234, payee: { kind: "none" }, categoryId: null })))
    await h.run(
      Transactions.use((t) => t.list({ accountId: account })).pipe(Effect.flatMap((p) => Transactions.use((t) => t.setCleared(p.rows.map((r) => r.id), true)))),
    )
    const before = (await h.run(Accounts.use((a) => a.list))).find((a) => a.id === account)!
    expect(before.clearedBalance).toBe(48766)
    const result = await h.run(Accounts.use((a) => a.reconcile(account, before.clearedBalance - 100)))
    expect(result.adjustment).toBe(-100)
    const page = await h.run(Transactions.use((t) => t.list({ accountId: account })))
    expect(page.rows.every((r) => r.reconciled)).toBe(true)
  })

  it("deletes a category and moves its history", async () => {
    const make = (name: string) => h.run(Categories.use((c) => c.create({ groupId: ids.daily, name }))).then((c) => c.id)
    const doomed = await make("Pressing")
    const kept = await make("Entretien")
    const add = (categoryId: string, amount: number) =>
      h.run(Transactions.use((t) => t.create({ accountId: ids.checking, date: "2027-03-10", amount, payee: { kind: "none" }, categoryId })))
    await add(doomed, -700)
    await add(kept, -300)
    await h.run(
      Rules.use((r) =>
        r.create({
          conditionsOp: "and",
          conditions: [{ field: "payee", op: "is", value: "Pressing du coin" }],
          actions: [{ type: "set_category", categoryId: doomed }],
        }),
      ),
    )

    await h.run(Categories.use((c) => c.remove(doomed, kept)))
    expect((await categoryRow("2027-03", kept)).spent).toBe(1000)
    const rule = (await h.run(Rules.use((r) => r.list))).find((r) => r.conditions[0]?.value === "Pressing du coin")!
    expect(rule.actions).toEqual([{ type: "set_category", categoryId: kept }])
  })
})

describe("demo data", () => {
  it("seeds a realistic year on an empty budget", async () => {
    const fresh = await createHarness()
    try {
      const { Demo } = await import("~/server/services/demo")
      const { ForecastService } = await import("~/server/services/forecast")
      const result = await fresh.run(Demo.use((d) => d.seed))
      expect(result.transactions).toBeGreaterThan(150)
      const accounts = await fresh.run(Accounts.use((a) => a.list))
      expect(accounts).toHaveLength(2)
      const forecast = await fresh.run(ForecastService.use((f) => f.month()))
      expect(forecast.upcoming.length).toBeGreaterThan(0)
      expect(forecast.days.length).toBeGreaterThan(27)
      await expect(fresh.run(Demo.use((d) => d.seed))).rejects.toThrow(/budget vide/)
    } finally {
      await fresh.dispose()
    }
  })

  it("can be loaded again after failing halfway", async () => {
    const fresh = await createHarness()
    try {
      const { Demo } = await import("~/server/services/demo")
      await fresh.d1.prepare("CREATE TRIGGER no_schedules BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT, 'boom'); END").run()
      await expect(fresh.run(Demo.use((d) => d.seed))).rejects.toThrow()
      expect(await fresh.run(Accounts.use((a) => a.list))).toHaveLength(0)
      await fresh.d1.prepare("DROP TRIGGER no_schedules").run()
      expect((await fresh.run(Demo.use((d) => d.seed))).transactions).toBeGreaterThan(150)
    } finally {
      await fresh.dispose()
    }
  })
})

describe("settings", () => {
  it("falls back to the default for a stored value of the wrong shape", async () => {
    await h.d1.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('aiEnabled', '"oui"'), ('timeZone', '42')`).run()
    expect(await h.run(Settings.use((s) => s.get("aiEnabled")))).toBe(true)
    expect(await h.run(Settings.use((s) => s.all))).toMatchObject({ aiEnabled: true, timeZone: "Europe/Paris" })
    await h.d1.prepare(`DELETE FROM settings WHERE key IN ('aiEnabled', 'timeZone')`).run()
  })
})

describe("bank re-import", () => {
  it("recognises a line already imported even after a rule renamed its payee", async () => {
    const fresh = await createHarness({ now: NOW })
    try {
      const account = await fresh.run(
        Accounts.use((a) => a.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2026-09-01" })),
      )
      const [store] = await fresh.run(Payees.use((p) => p.resolveNames(["Monoprix"]))).then((m) => [...m.values()])
      await fresh.run(
        Rules.use((r) =>
          r.create({
            conditionsOp: "and",
            conditions: [{ field: "imported_payee", op: "contains", value: "carrefour" }],
            actions: [{ type: "set_payee", payeeId: store! }],
          }),
        ),
      )
      const line = { accountId: account, date: "2026-09-12", amount: -1_999, payeeName: "CARREFOUR CITY 75", importedPayee: "CARREFOUR CITY 75", cleared: true }
      const options = { dedupe: true, applyRules: true }
      expect(await fresh.run(ImportExport.use((s) => s.importTransactions([line], options)))).toEqual({ inserted: 1, duplicates: 0, skipped: 0 })
      expect(await fresh.run(ImportExport.use((s) => s.importTransactions([line, { ...line, amount: -2_999 }], options)))).toEqual({
        inserted: 1,
        duplicates: 1,
        skipped: 0,
      })
    } finally {
      await fresh.dispose()
    }
  })
})

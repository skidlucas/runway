import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { Rules } from "~/server/services/rules"
import { Settings } from "~/server/services/settings"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h?.dispose()
})

const ids = { checking: "", savings: "", courses: "", transport: "", income: "" }

describe("core flows on D1", () => {
  it("creates starter categories and accounts with starting balances", async () => {
    await h.run(Categories.use((c) => c.createStarterSet))
    const tree = await h.run(Categories.use((c) => c.tree))
    expect(tree.map((g) => g.name)).toEqual(["Logement", "Quotidien", "Loisirs", "Épargne", "Revenus"])
    const cat = (name: string) => tree.flatMap((g) => g.categories).find((c) => c.name === name)!.id
    ids.courses = cat("Courses")
    ids.transport = cat("Transport")
    ids.income = cat("Revenus")

    ids.checking = await h.run(
      Accounts.use((a) =>
        a.create({ name: "Compte courant", kind: "checking", offBudget: false, startingBalance: 100000, startingDate: "2026-09-01" }),
      ),
    )
    ids.savings = await h.run(
      Accounts.use((a) =>
        a.create({ name: "Livret A", kind: "savings", offBudget: true, startingBalance: 840000, startingDate: "2026-09-01" }),
      ),
    )
    const accounts = await h.run(Accounts.use((a) => a.list))
    expect(accounts.map((a) => [a.name, a.balance])).toEqual([
      ["Compte courant", 100000],
      ["Livret A", 840000],
    ])
  })

  it("counts the starting balance as income in the budget", async () => {
    const month = await h.run(Budget.use((b) => b.month("2026-09")))
    expect(month.income).toBe(100000)
    expect(month.toBudget).toBe(100000)
  })

  it("budgets, spends, and carries over", async () => {
    await h.run(Budget.use((b) => b.setAmount("2026-09", ids.courses, 40000)))
    await h.run(
      Transactions.use((t) =>
        t.create({ accountId: ids.checking, date: "2026-09-10", amount: -4218, payee: { kind: "name", name: "Monoprix" }, categoryId: ids.courses }),
      ),
    )
    const sept = await h.run(Budget.use((b) => b.month("2026-09")))
    const courses = sept.groups.flatMap((g) => g.categories).find((c) => c.id === ids.courses)!
    expect(courses).toMatchObject({ budgeted: 40000, spent: 4218, available: 35782 })
    expect(sept.toBudget).toBe(60000)
    const oct = await h.run(Budget.use((b) => b.month("2026-10")))
    expect(oct.groups.flatMap((g) => g.categories).find((c) => c.id === ids.courses)!.available).toBe(35782)
    expect(oct.toBudget).toBe(60000)
  })

  it("learns the category of a payee and applies rules", async () => {
    const learned = await h.run(
      Transactions.use((t) =>
        t.create({ accountId: ids.checking, date: "2026-10-02", amount: -1999, payee: { kind: "name", name: "monoprix" } }),
      ),
    )
    expect((await h.run(Transactions.use((t) => t.get(learned)))).categoryId).toBe(ids.courses)

    await h.run(
      Rules.use((r) =>
        r.create({
          conditionsOp: "and",
          conditions: [{ field: "imported_payee", op: "contains", value: "total" }],
          actions: [{ type: "set_category", categoryId: ids.transport }],
        }),
      ),
    )
    const ruled = await h.run(
      Transactions.use((t) =>
        t.create({
          accountId: ids.checking,
          date: "2026-10-03",
          amount: -5830,
          payee: { kind: "name", name: "TotalEnergies" },
          importedPayee: "CB TOTAL ENERGIES 03/10",
        }),
      ),
    )
    expect((await h.run(Transactions.use((t) => t.get(ruled)))).categoryId).toBe(ids.transport)
  })

  it("creates transfers with a linked mirror and keeps them in sync", async () => {
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

    await h.run(Transactions.use((t) => t.remove([id])))
    const savings = (await h.run(Accounts.use((a) => a.list))).find((a) => a.id === ids.savings)!
    expect(savings.balance).toBe(840000)
  })

  it("splits a transaction across categories", async () => {
    const id = await h.run(
      Transactions.use((t) =>
        t.create({
          accountId: ids.checking,
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
    const page = await h.run(Transactions.use((t) => t.list({ accountId: ids.checking })))
    const parent = page.rows.find((r) => r.id === id)!
    expect(parent.isParent).toBe(true)
    expect(page.children[id]?.map((c) => c.amount)).toEqual([-6000, -4000])
    // Running balance: starting 1000 € − 42,18 − 19,99 − 58,30 − 100.
    expect(page.rows[0]?.balance).toBe(100000 - 4218 - 1999 - 5830 - 10000)

    const oct = await h.run(Budget.use((b) => b.month("2026-10")))
    const spent = (cid: string) => oct.groups.flatMap((g) => g.categories).find((c) => c.id === cid)!.spent
    expect(spent(ids.courses)).toBe(1999 + 6000)
    expect(spent(ids.transport)).toBe(5830 + 4000)
  })

  it("reconciles an account and books the difference", async () => {
    await h.run(Transactions.use((t) => t.list({ accountId: ids.checking })).pipe(Effect.flatMap((p) => Transactions.use((t) => t.setCleared(p.rows.map((r) => r.id), true)))))
    const before = (await h.run(Accounts.use((a) => a.list))).find((a) => a.id === ids.checking)!
    const result = await h.run(Accounts.use((a) => a.reconcile(ids.checking, before.clearedBalance - 100)))
    expect(result.adjustment).toBe(-100)
    const page = await h.run(Transactions.use((t) => t.list({ accountId: ids.checking })))
    expect(page.rows.every((r) => r.reconciled)).toBe(true)
  })

  it("deletes a category and moves its history", async () => {
    await h.run(Categories.use((c) => c.remove(ids.transport, ids.courses)))
    const oct = await h.run(Budget.use((b) => b.month("2026-10")))
    const courses = oct.groups.flatMap((g) => g.categories).find((c) => c.id === ids.courses)!
    expect(courses.spent).toBe(1999 + 6000 + 5830 + 4000)
    const rules = await h.run(Rules.use((r) => r.list))
    expect(rules[0]?.actions).toEqual([{ type: "set_category", categoryId: ids.courses }])
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
})

describe("settings", () => {
  it("falls back to the default for a stored value of the wrong shape", async () => {
    await h.d1.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('aiEnabled', '"oui"'), ('timeZone', '42')`).run()
    expect(await h.run(Settings.use((s) => s.get("aiEnabled")))).toBe(true)
    expect(await h.run(Settings.use((s) => s.all))).toMatchObject({ aiEnabled: true, timeZone: "Europe/Paris" })
    await h.d1.prepare(`DELETE FROM settings WHERE key IN ('aiEnabled', 'timeZone')`).run()
  })
})

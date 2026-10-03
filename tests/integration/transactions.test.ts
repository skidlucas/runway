import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { Payees } from "~/server/services/payees"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

describe("Transactions", () => {
  let h: Harness
  let account: string
  let savings: string
  let categories: string[]

  beforeAll(async () => {
    h = await createHarness()
    await h.run(Categories.use((c) => c.createStarterSet))
    const tree = await h.run(Categories.use((c) => c.tree))
    categories = tree.filter((g) => !g.isIncome).flatMap((g) => g.categories.map((c) => c.id))
    const create = (name: string) =>
      h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget: false, startingBalance: 100_000, startingDate: "2026-01-01" })))
    account = await create("Courant")
    savings = await create("Épargne")
  }, 60_000)
  afterAll(() => h?.dispose())

  const lines = (parentId: string) =>
    h.d1.prepare("SELECT date, amount FROM transactions WHERE parent_id = ? ORDER BY amount").bind(parentId).all<{ date: string; amount: number }>()

  it("saves a split with many lines", async () => {
    const splits = Array.from({ length: 12 }, (_, i) => ({ amount: -1_000, categoryId: categories[i % categories.length]! }))
    const id = await h.run(
      Transactions.use((t) => t.create({ accountId: account, date: "2026-07-31", amount: -12_000, payee: { kind: "name", name: "Hypermarché" }, splits })),
    )
    expect((await lines(id)).results).toHaveLength(12)
  })

  it("moves split lines with their parent so the budget follows the date", async () => {
    const id = await h.run(
      Transactions.use((t) =>
        t.create({
          accountId: account,
          date: "2026-08-31",
          amount: -1_000,
          payee: { kind: "name", name: "Pharmacie" },
          splits: [
            { amount: -600, categoryId: categories[0]! },
            { amount: -400, categoryId: categories[1]! },
          ],
        }),
      ),
    )
    // `+ 0` turns the -0 of an empty month into 0.
    const spentIn = async (month: string) => (await h.run(Budget.use((b) => b.month(month)))).spent + 0
    const augustBefore = await spentIn("2026-08")
    const septemberBefore = await spentIn("2026-09")

    await h.run(Transactions.use((t) => t.update(id, { date: "2026-09-01" })))
    expect((await lines(id)).results.map((l) => l.date)).toEqual(["2026-09-01", "2026-09-01"])
    expect(await spentIn("2026-08")).toBe(augustBefore - 1_000)
    expect(await spentIn("2026-09")).toBe(septemberBefore + 1_000)
  })

  it("rewrites a transaction in place when it becomes a transfer", async () => {
    const id = await h.run(
      Transactions.use((t) => t.create({ accountId: account, date: "2026-09-10", amount: -5_000, payee: { kind: "name", name: "Virement perso" } })),
    )
    await h.run(Transactions.use((t) => t.update(id, { payee: { kind: "transfer", accountId: savings } })))
    const { results } = await h.d1
      .prepare("SELECT id, account_id AS accountId, amount, transfer_id AS transferId FROM transactions WHERE id = ?1 OR transfer_id = ?1")
      .bind(id)
      .all<{ id: string; accountId: string; amount: number; transferId: string | null }>()
    expect(results).toHaveLength(2)
    const mirror = results.find((r) => r.id !== id)!
    expect(mirror).toMatchObject({ accountId: savings, amount: 5_000, transferId: id })
    expect(results.find((r) => r.id === id)!.transferId).toBe(mirror.id)
  })

  it("refuses to split a transfer", async () => {
    await expect(
      h.run(
        Transactions.use((t) =>
          t.create({
            accountId: account,
            date: "2026-09-12",
            amount: -2_000,
            payee: { kind: "transfer", accountId: savings },
            splits: [
              { amount: -1_000, categoryId: categories[0]! },
              { amount: -1_000, categoryId: categories[1]! },
            ],
          }),
        ),
      ),
    ).rejects.toThrow("Un virement ne peut pas être ventilé")
  })

  it("deletes thousands of transactions at once", async () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      ids.push(
        await h.run(
          Transactions.use((t) => t.create({ accountId: account, date: "2026-09-15", amount: -100 - i, payee: { kind: "transfer", accountId: savings } })),
        ),
      )
    }
    await h.run(Transactions.use((t) => t.remove([...ids, ...Array.from({ length: 5_000 }, (_, i) => `missing-${i}`)])))
    const { results } = await h.d1
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE date = '2026-09-15'")
      .all<{ n: number }>()
    expect(results[0]!.n).toBe(0)
  })

  it("undoes a deletion with the split lines and the transfer mirror", async () => {
    const snapshot = () =>
      h.d1
        .prepare("SELECT * FROM transactions WHERE date = '2026-09-20' ORDER BY id")
        .all()
        .then((r) => r.results)
    await h.run(
      Transactions.use((t) =>
        t.create({
          accountId: account,
          date: "2026-09-20",
          amount: -3_000,
          payee: { kind: "name", name: "Grand magasin" },
          splits: [
            { amount: -2_000, categoryId: categories[0]! },
            { amount: -1_000, categoryId: categories[1]! },
          ],
        }),
      ),
    )
    const transfer = await h.run(
      Transactions.use((t) => t.create({ accountId: account, date: "2026-09-20", amount: -7_000, payee: { kind: "transfer", accountId: savings } })),
    )
    const before = await snapshot()
    expect(before).toHaveLength(5)
    const parent = (before as Array<{ id: string; is_parent: number }>).find((r) => r.is_parent === 1)!

    const { undoId } = await h.run(Transactions.use((t) => t.remove([parent.id, transfer])))
    expect(await snapshot()).toHaveLength(0)

    expect(await h.run(Transactions.use((t) => t.restore(undoId)))).toEqual({ restored: 5 })
    expect(await snapshot()).toEqual(before)
    await expect(h.run(Transactions.use((t) => t.restore(undoId)))).rejects.toThrow("ne peut plus être annulée")
  })

  it("undoes a deletion whose payee was cleaned up since", async () => {
    const id = await h.run(
      Transactions.use((t) =>
        t.create({ accountId: account, date: "2026-09-21", amount: -900, payee: { kind: "name", name: "Commerce éphémère" }, categoryId: categories[0]! }),
      ),
    )
    const { undoId } = await h.run(Transactions.use((t) => t.remove([id])))
    expect(await h.run(Payees.use((p) => p.deleteUnused))).toBeGreaterThan(0)

    expect(await h.run(Transactions.use((t) => t.restore(undoId)))).toEqual({ restored: 1 })
    const row = await h.d1.prepare("SELECT payee_id, category_id FROM transactions WHERE id = ?").bind(id).first()
    expect(row).toEqual({ payee_id: null, category_id: categories[0] })
  })

  it("keeps the bank id, the opening flag and the other side's status when an edit rewrites a transaction", async () => {
    const row = (id: string) =>
      h.d1
        .prepare("SELECT imported_id AS importedId, starting_balance AS startingBalance, cleared, reconciled, transfer_id AS transferId FROM transactions WHERE id = ?")
        .bind(id)
        .first<{ importedId: string | null; startingBalance: number; cleared: number; reconciled: number; transferId: string | null }>()

    const imported = await h.run(
      Transactions.use((t) => t.create({ accountId: account, date: "2026-09-02", amount: -2_500, payee: { kind: "name", name: "Boulangerie" } })),
    )
    await h.d1.prepare("UPDATE transactions SET imported_id = 'FIT-42' WHERE id = ?").bind(imported).run()
    await h.run(Transactions.use((t) => t.update(imported, { payee: { kind: "name", name: "Boulangerie du coin" } })))
    expect((await row(imported))?.importedId).toBe("FIT-42")

    const opening = await h.d1
      .prepare("SELECT id FROM transactions WHERE account_id = ? AND starting_balance = 1")
      .bind(account)
      .first<{ id: string }>()
    await h.run(Transactions.use((t) => t.update(opening!.id, { payee: { kind: "name", name: "Report" } })))
    expect((await row(opening!.id))?.startingBalance).toBe(1)

    const transfer = await h.run(
      Transactions.use((t) => t.create({ accountId: account, date: "2026-09-03", amount: -5_000, payee: { kind: "transfer", accountId: savings } })),
    )
    const mirror = (await row(transfer))!.transferId!
    await h.d1.prepare("UPDATE transactions SET cleared = 1, reconciled = 1 WHERE id = ?").bind(mirror).run()
    await h.run(Transactions.use((t) => t.update(transfer, { amount: -6_000, payee: { kind: "transfer", accountId: savings } })))
    expect(await row(mirror)).toMatchObject({ cleared: 1, reconciled: 1 })
  })

  it("only lets a split line change through its parent", async () => {
    const id = await h.run(
      Transactions.use((t) =>
        t.create({
          accountId: account,
          date: "2026-09-04",
          amount: -1_000,
          payee: { kind: "name", name: "Marché" },
          splits: [
            { amount: -700, categoryId: categories[0]! },
            { amount: -300, categoryId: categories[1]! },
          ],
        }),
      ),
    )
    const line = await h.d1.prepare("SELECT id FROM transactions WHERE parent_id = ? LIMIT 1").bind(id).first<{ id: string }>()
    expect(await h.fail(Transactions.use((t) => t.update(line!.id, { amount: -100 })))).toMatchObject({ _tag: "Invalid" })
    expect(await h.fail(Transactions.use((t) => t.remove([line!.id])))).toMatchObject({ _tag: "Invalid" })
    await h.run(Transactions.use((t) => t.update(line!.id, { categoryId: categories[2]! })))
    expect((await lines(id)).results.map((l) => l.amount)).toEqual([-700, -300])
  })
})

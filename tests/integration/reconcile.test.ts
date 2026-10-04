import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Categories } from "~/server/services/categories"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

describe("Reconciliation", () => {
  let h: Harness
  let groceries: string
  let rent: string
  let accounts = 0

  const account = (startingBalance: number) =>
    h.run(Accounts.use((a) => a.create({ name: `Compte ${++accounts}`, kind: "checking", offBudget: false, startingBalance, startingDate: "2026-09-01" })))
  const add = (accountId: string, amount: number, cleared: boolean, splits?: Array<{ amount: number; categoryId: string }>) =>
    h.run(
      Transactions.use((t) => t.create({ accountId, date: "2026-09-15", amount, payee: { kind: "name", name: "Magasin" }, categoryId: null, cleared, splits })),
    )
  const reconcile = (accountId: string, statement: number) => h.run(Accounts.use((a) => a.reconcile(accountId, statement)))
  const rows = async (accountId: string) =>
    (
      await h.d1
        .prepare("SELECT amount, date, cleared, reconciled, parent_id AS parentId, notes FROM transactions WHERE account_id = ? ORDER BY rowid")
        .bind(accountId)
        .all<{ amount: number; date: string; cleared: number; reconciled: number; parentId: string | null; notes: string | null }>()
    ).results
  const adjustments = async (accountId: string) => (await rows(accountId)).filter((r) => r.notes === "Écart constaté au rapprochement")
  const lastReconciledAt = async (accountId: string) => (await h.run(Accounts.use((a) => a.list))).find((a) => a.id === accountId)!.lastReconciledAt

  beforeAll(async () => {
    h = await createHarness({ now: "2026-10-04T10:00:00Z" })
    await h.run(Categories.use((c) => c.createStarterSet))
    const all = (await h.run(Categories.use((c) => c.tree))).flatMap((g) => g.categories)
    groceries = all.find((c) => c.name === "Courses")!.id
    rent = all.find((c) => c.name === "Loyer")!.id
  }, 60_000)
  afterAll(() => h?.dispose())

  it("books nothing when the statement matches, and still locks the cleared lines", async () => {
    const id = await account(100_000)
    await add(id, -20_000, true)
    expect(await reconcile(id, 80_000)).toEqual({ adjustment: 0 })
    expect(await adjustments(id)).toEqual([])
    expect((await rows(id)).map((r) => r.reconciled)).toEqual([1, 1])
    expect(await lastReconciledAt(id)).toBe("2026-10-04")
  })

  it("books the difference once, however many times the same statement is submitted", async () => {
    const id = await account(100_000)
    expect(await reconcile(id, 90_000)).toEqual({ adjustment: -10_000 })
    expect(await reconcile(id, 90_000)).toEqual({ adjustment: 0 })
    expect(await adjustments(id)).toMatchObject([{ amount: -10_000, date: "2026-10-04", cleared: 1, reconciled: 1 }])
    expect(await reconcile(id, 95_000)).toEqual({ adjustment: 5_000 })
    expect((await adjustments(id)).map((r) => r.amount)).toEqual([-10_000, 5_000])
  })

  it("leaves the lines not yet cleared out of the balance and unlocked", async () => {
    const id = await account(100_000)
    await add(id, -30_000, false)
    expect(await reconcile(id, 100_000)).toEqual({ adjustment: 0 })
    expect((await rows(id)).map((r) => [r.amount, r.reconciled])).toEqual([
      [100_000, 1],
      [-30_000, 0],
    ])
  })

  it("counts a split once, by its total, and locks its lines with it", async () => {
    const id = await account(100_000)
    await add(id, -3_000, true, [
      { amount: -2_000, categoryId: groceries },
      { amount: -1_000, categoryId: rent },
    ])
    expect(await reconcile(id, 97_000)).toEqual({ adjustment: 0 })
    expect((await rows(id)).every((r) => r.reconciled === 1)).toBe(true)
  })

  it("refuses a statement balance that is not in cents", async () => {
    const id = await account(0)
    expect(await h.fail(Accounts.use((a) => a.reconcile(id, 10.5)))).toMatchObject({ _tag: "Invalid" })
    expect(await lastReconciledAt(id)).toBeNull()
  })
})

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { Rules } from "~/server/services/rules"
import { Schedules } from "~/server/services/schedules"
import { type TxPayeeInput, Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

type Side = { id: string; accountId: string; amount: number; date: string; transferId: string | null; categoryId: string | null; payeeAccount: string | null }

describe("Transfers", () => {
  let h: Harness
  let checking: string
  let savings: string
  let joint: string
  let broker: string
  let groceries: string

  const account = (name: string, offBudget: boolean) =>
    h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget, startingBalance: 0, startingDate: "2026-01-01" })))
  const create = (accountId: string, amount: number, payee: TxPayeeInput, categoryId?: string | null) =>
    h.run(Transactions.use((t) => t.create({ accountId, date: "2026-09-10", amount, payee, categoryId })))
  const transfer = (from: string, to: string, amount: number, categoryId?: string | null) => create(from, amount, { kind: "transfer", accountId: to }, categoryId)
  /** The rows linked to `id`: itself and its mirror, `id` first. */
  const sides = async (id: string) =>
    (
      await h.d1
        .prepare(
          `SELECT t.id, t.account_id AS accountId, t.amount, t.date, t.transfer_id AS transferId, t.category_id AS categoryId,
                  p.transfer_account_id AS payeeAccount
           FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
           WHERE t.id = ?1 OR t.transfer_id = ?1 ORDER BY t.id = ?1 DESC`,
        )
        .bind(id)
        .all<Side>()
    ).results
  const exists = async (id: string) => (await h.d1.prepare("SELECT 1 AS x FROM transactions WHERE id = ?").bind(id).first()) !== null

  beforeAll(async () => {
    h = await createHarness({ now: "2026-10-04T10:00:00Z" })
    await h.run(Categories.use((c) => c.createStarterSet))
    groceries = (await h.run(Categories.use((c) => c.tree))).flatMap((g) => g.categories).find((c) => c.name === "Courses")!.id
    checking = await account("Courant", false)
    savings = await account("Livret", false)
    joint = await account("Joint", false)
    broker = await account("Courtier", true)
  }, 60_000)
  afterAll(() => h?.dispose())

  it("creates two linked sides, each paid to the other account", async () => {
    const id = await transfer(checking, savings, -10_000, groceries)
    const [out, into] = await sides(id)
    expect(out).toMatchObject({ accountId: checking, amount: -10_000, payeeAccount: savings, categoryId: null })
    expect(into).toMatchObject({ accountId: savings, amount: 10_000, date: "2026-09-10", transferId: id, payeeAccount: checking, categoryId: null })
    expect(out!.transferId).toBe(into!.id)
  })

  it("keeps both sides in step when either one changes amount or date", async () => {
    const id = await transfer(checking, savings, -10_000)
    const mirror = (await sides(id))[1]!.id
    await h.run(Transactions.use((t) => t.update(id, { amount: -12_000 })))
    await h.run(Transactions.use((t) => t.update(mirror, { amount: 15_000, date: "2026-09-12" })))
    expect((await sides(id)).map((s) => [s.amount, s.date])).toEqual([
      [-15_000, "2026-09-12"],
      [15_000, "2026-09-12"],
    ])
  })

  it("moves one side to another account and keeps the other side pointing at it", async () => {
    const id = await transfer(checking, savings, -10_000)
    const mirror = (await sides(id))[1]!.id
    await h.run(Transactions.use((t) => t.update(id, { accountId: joint })))
    expect(await sides(id)).toMatchObject([
      { accountId: joint, amount: -10_000, payeeAccount: savings, transferId: mirror },
      { id: mirror, accountId: savings, amount: 10_000, payeeAccount: joint, transferId: id },
    ])
  })

  it("refuses to move one side onto the account of the other", async () => {
    const id = await transfer(checking, savings, -10_000)
    expect(await h.fail(Transactions.use((t) => t.update(id, { accountId: savings })))).toMatchObject({ _tag: "Invalid" })
    expect((await sides(id)).map((s) => s.accountId)).toEqual([checking, savings])
  })

  it("deletes both sides when one is deleted, and brings both back on undo", async () => {
    const id = await transfer(checking, savings, -10_000)
    const mirror = (await sides(id))[1]!.id
    const { undoId } = await h.run(Transactions.use((t) => t.remove([mirror])))
    expect([await exists(id), await exists(mirror)]).toEqual([false, false])
    await h.run(Transactions.use((t) => t.restore(undoId)))
    expect((await sides(id)).map((s) => [s.id, s.transferId])).toEqual([
      [id, mirror],
      [mirror, id],
    ])
  })

  it("becomes an ordinary transaction without leaving its other side behind, and a transfer again", async () => {
    const id = await transfer(checking, savings, -10_000)
    const mirror = (await sides(id))[1]!.id
    await h.run(Transactions.use((t) => t.update(id, { payee: { kind: "name", name: "Supermarché" }, categoryId: groceries })))
    expect(await exists(mirror)).toBe(false)
    expect(await sides(id)).toEqual([{ id, accountId: checking, amount: -10_000, date: "2026-09-10", transferId: null, categoryId: groceries, payeeAccount: null }])

    await h.run(Transactions.use((t) => t.update(id, { payee: { kind: "transfer", accountId: savings } })))
    const [out, into] = await sides(id)
    expect(out).toMatchObject({ transferId: into!.id, categoryId: null, payeeAccount: savings })
    expect(into).toMatchObject({ accountId: savings, amount: 10_000, transferId: id })
  })

  it("keeps the category on the budget side of a transfer that leaves or enters the budget", async () => {
    const leaving = await transfer(checking, broker, -10_000, groceries)
    expect((await sides(leaving)).map((s) => [s.accountId, s.categoryId])).toEqual([
      [checking, groceries],
      [broker, null],
    ])
    // Entered from the off-budget account, both sides keep the category; nothing off budget is
    // counted anywhere, so only the checking side matters.
    const entering = await transfer(broker, checking, -4_000, groceries)
    expect((await sides(entering)).map((s) => [s.accountId, s.categoryId])).toEqual([
      [broker, groceries],
      [checking, groceries],
    ])
  })

  it("counts a transfer leaving the budget as spending, and one between budget accounts as nothing", async () => {
    const spent = async () => (await h.run(Budget.use((b) => b.month("2026-11")))).spent + 0
    const before = await spent()
    await h.run(Transactions.use((t) => t.create({ accountId: checking, date: "2026-11-02", amount: -7_000, payee: { kind: "transfer", accountId: savings }, categoryId: groceries })))
    expect(await spent()).toBe(before)
    await h.run(Transactions.use((t) => t.create({ accountId: checking, date: "2026-11-03", amount: -3_000, payee: { kind: "transfer", accountId: broker }, categoryId: groceries })))
    expect(await spent()).toBe(before + 3_000)
  })

  it("updates the categories of an account's transfers and opening balance when it enters or leaves the budget", async () => {
    const pea = await account("PEA", true)
    const leaving = await transfer(checking, pea, -6_000, groceries)
    const update = (offBudget: boolean) => h.run(Accounts.use((a) => a.update(pea, { offBudget })))
    const categories = async () => (await sides(leaving)).map((s) => s.categoryId)

    await update(false)
    expect(await categories()).toEqual([null, null])
    await h.run(Transactions.use((t) => t.update(leaving, { categoryId: groceries })))
    await update(true)
    expect(await categories()).toEqual([null, null])

    const funded = await h.run(
      Accounts.use((a) => a.create({ name: "Héritage", kind: "savings", offBudget: true, startingBalance: 90_000, startingDate: "2026-12-01" })),
    )
    const income = async () => (await h.run(Budget.use((b) => b.month("2026-12")))).income
    const before = await income()
    await h.run(Accounts.use((a) => a.update(funded, { offBudget: false })))
    expect(await income()).toBe(before + 90_000)
    await h.run(Accounts.use((a) => a.update(funded, { offBudget: true })))
    expect(await income()).toBe(before)
  })
})

describe("Removing an account", () => {
  let h: Harness
  let groceries: string

  const account = (name: string, startingBalance = 0) =>
    h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget: false, startingBalance, startingDate: "2026-01-01" })))
  const count = async (sql: string, ...params: unknown[]) =>
    (await h.d1.prepare(sql).bind(...params).first<{ n: number }>())!.n

  beforeAll(async () => {
    h = await createHarness({ now: "2026-10-04T10:00:00Z" })
    await h.run(Categories.use((c) => c.createStarterSet))
    groceries = (await h.run(Categories.use((c) => c.tree))).flatMap((g) => g.categories).find((c) => c.name === "Courses")!.id
  }, 60_000)
  afterAll(() => h?.dispose())

  it("takes its transactions, split lines and opening balance out of the budget", async () => {
    const month = "2026-01"
    const before = await h.run(Budget.use((b) => b.month(month)))
    const doomed = await account("À fermer", 50_000)
    await h.run(
      Transactions.use((t) =>
        t.create({
          accountId: doomed,
          date: "2026-01-15",
          amount: -3_000,
          payee: { kind: "name", name: "Marché" },
          splits: [
            { amount: -2_000, categoryId: groceries },
            { amount: -1_000, categoryId: null },
          ],
        }),
      ),
    )
    expect((await h.run(Budget.use((b) => b.month(month)))).income).toBe(before.income + 50_000)

    await h.run(Accounts.use((a) => a.remove(doomed)))
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?", doomed)).toBe(0)
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", doomed)).toBe(0)
    expect(await h.run(Budget.use((b) => b.month(month)))).toMatchObject({ income: before.income, spent: before.spent, toBudget: before.toBudget })
  })

  it("leaves the other side of its transfers as an uncategorized line paid to a payee named after it", async () => {
    const kept = await account("Gardé")
    const doomed = await account("À fermer")
    const id = await h.run(
      Transactions.use((t) => t.create({ accountId: kept, date: "2026-09-10", amount: -8_000, payee: { kind: "transfer", accountId: doomed } })),
    )
    const before = (await h.run(Budget.use((b) => b.month("2026-09")))).uncategorized

    await h.run(Accounts.use((a) => a.remove(doomed)))
    const row = await h.run(Transactions.use((t) => t.get(id)))
    expect(row).toMatchObject({ accountId: kept, amount: -8_000, transferId: null, transferAccountId: null, categoryId: null })
    expect(await count("SELECT COUNT(*) AS n FROM payees WHERE id = ? AND name = 'À fermer' AND transfer_account_id IS NULL", row.payeeId)).toBe(1)
    expect(await count("SELECT COUNT(*) AS n FROM payees WHERE transfer_account_id = ?", doomed)).toBe(0)
    // Money that used to move inside the budget now leaves it: the budget asks to categorize it.
    expect((await h.run(Budget.use((b) => b.month("2026-09")))).uncategorized).toEqual({ count: before.count + 1, amount: before.amount - 8_000 })
  })

  it("creates no payee for an account that had no transfers", async () => {
    const doomed = await account("Sans virement")
    await h.run(Accounts.use((a) => a.remove(doomed)))
    expect(await count("SELECT COUNT(*) AS n FROM payees WHERE name = 'Sans virement'")).toBe(0)
  })

  it("drops the conditions on it from rules, and switches off the rules that required it", async () => {
    const kept = await account("Gardé")
    const doomed = await account("À fermer")
    const rule = (conditionsOp: "and" | "or", accountId: string) =>
      h.run(
        Rules.use((r) =>
          r.create({
            conditionsOp,
            conditions: [
              { field: "account", op: "is", value: accountId },
              { field: "payee", op: "contains", value: "carrefour" },
            ],
            actions: [{ type: "set_category", categoryId: groceries }],
          }),
        ),
      )
    const required = await rule("and", doomed)
    const either = await rule("or", doomed)
    const other = await rule("and", kept)

    await h.run(Accounts.use((a) => a.remove(doomed)))
    const rules = await h.run(Rules.use((r) => r.list))
    const byId = (id: string) => rules.find((r) => r.id === id)!
    expect(byId(required.id)).toMatchObject({ enabled: false, conditions: [{ field: "payee", op: "contains", value: "carrefour" }] })
    expect(byId(either.id)).toMatchObject({ enabled: true, conditions: [{ field: "payee", op: "contains", value: "carrefour" }] })
    expect(byId(other.id)).toMatchObject({ enabled: true, conditions: other.conditions })
  })

  it("deletes its schedules and repoints the schedules that pay into it", async () => {
    const kept = await account("Gardé")
    const doomed = await account("À fermer")
    const schedule = (accountId: string, payee: TxPayeeInput, name: string) =>
      h.run(
        Schedules.use((s) =>
          s.create({ name, payee, accountId, categoryId: null, amount: -5_000, recurrence: { unit: "month", interval: 1 }, startDate: "2026-11-01", autoPost: false }),
        ),
      )
    const own = await schedule(doomed, { kind: "name", name: "Box" }, "Box")
    const into = await schedule(kept, { kind: "transfer", accountId: doomed }, "Épargne mensuelle")

    await h.run(Accounts.use((a) => a.remove(doomed)))
    const list = await h.run(Schedules.use((s) => s.list))
    expect(list.find((s) => s.id === own)).toBeUndefined()
    expect(list.find((s) => s.id === into)).toMatchObject({ accountId: kept, payeeName: "À fermer", active: true })
  })
})

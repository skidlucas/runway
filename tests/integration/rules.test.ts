import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { RuleCondition } from "~/domain/rules"
import { Accounts } from "~/server/services/accounts"
import { Categories } from "~/server/services/categories"
import { type RuleInput, Rules } from "~/server/services/rules"
import { type TxPayeeInput, Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

describe("Rules", () => {
  let h: Harness
  let checking: string
  let savings: string
  let broker: string
  let groceries: string
  let leisure: string
  let payees = 0

  const categorize = (payee: string, categoryId: string, enabled = true): RuleInput => ({
    conditionsOp: "and",
    conditions: [{ field: "payee", op: "is", value: payee }],
    actions: [{ type: "set_category", categoryId }],
    enabled,
  })
  const create = (input: RuleInput) => h.run(Rules.use((r) => r.create(input)))
  const match = async (payeeName: string) =>
    (await h.run(Rules.use((r) => r.matcher)))({ payeeName, importedPayee: null, notes: null, amount: -1_000, accountId: checking }).categoryId
  const add = (accountId: string, payee: TxPayeeInput, extra: { categoryId?: string | null; splits?: Array<{ amount: number; categoryId: string | null }> } = {}) =>
    h.run(Transactions.use((t) => t.create({ accountId, date: "2026-09-10", amount: -1_000, payee, categoryId: null, ...extra })))
  const categoryOf = async (id: string) =>
    (await h.d1.prepare("SELECT category_id AS c FROM transactions WHERE id = ?").bind(id).first<{ c: string | null }>())!.c
  const freshPayee = () => `Magasin ${++payees}`

  beforeAll(async () => {
    h = await createHarness({ now: "2026-10-04T10:00:00Z" })
    await h.run(Categories.use((c) => c.createStarterSet))
    const all = (await h.run(Categories.use((c) => c.tree))).flatMap((g) => g.categories)
    groceries = all.find((c) => c.name === "Courses")!.id
    leisure = all.find((c) => c.name === "Sorties")!.id
    const open = (name: string, offBudget: boolean) =>
      h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget, startingBalance: 0, startingDate: "2026-01-01" })))
    checking = await open("Courant", false)
    savings = await open("Livret", false)
    broker = await open("Courtier", true)
  }, 60_000)
  afterAll(() => h?.dispose())

  it("edits a rule, keeping it enabled or not unless told", async () => {
    const payee = freshPayee()
    const rule = await create(categorize(payee, groceries, false))
    const { enabled: _, ...edit } = categorize(payee, leisure)
    await h.run(Rules.use((r) => r.update(rule.id, edit)))
    expect((await h.run(Rules.use((r) => r.list))).find((r) => r.id === rule.id)).toMatchObject({
      enabled: false,
      actions: [{ type: "set_category", categoryId: leisure }],
    })
    await h.run(Rules.use((r) => r.update(rule.id, categorize(payee, leisure, true))))
    expect(await match(payee)).toBe(leisure)
  })

  it("refuses to edit a rule that does not exist or to save one without condition", async () => {
    const rule = await create(categorize(freshPayee(), groceries))
    expect(await h.fail(Rules.use((r) => r.update("missing", categorize("x", groceries))))).toMatchObject({ _tag: "NotFound" })
    expect(await h.fail(Rules.use((r) => r.update(rule.id, { ...categorize("x", groceries), conditions: [] })))).toMatchObject({ _tag: "Invalid" })
    const bad: RuleCondition = { field: "payee", op: "matches", value: "(" }
    expect(await h.fail(Rules.use((r) => r.create({ ...categorize("x", groceries), conditions: [bad] })))).toMatchObject({ _tag: "Invalid" })
  })

  it("stops applying a removed rule, and lets the first rule in the new order win", async () => {
    const payee = freshPayee()
    const first = await create(categorize(payee, groceries))
    const second = await create(categorize(payee, leisure))
    expect(await match(payee)).toBe(groceries)
    const others = (await h.run(Rules.use((r) => r.list))).map((r) => r.id).filter((id) => id !== first.id && id !== second.id)
    await h.run(Rules.use((r) => r.reorder([second.id, first.id, ...others])))
    expect(await match(payee)).toBe(leisure)
    await h.run(Rules.use((r) => r.remove(second.id)))
    expect(await match(payee)).toBe(groceries)
  })

  it("categorizes the uncategorized lines, transfers and split totals aside", async () => {
    const payee = freshPayee()
    const plain = await add(checking, { kind: "name", name: payee })
    const offBudget = await add(broker, { kind: "name", name: payee })
    const filed = await add(checking, { kind: "name", name: payee }, { categoryId: leisure })
    const internal = await add(checking, { kind: "transfer", accountId: savings })
    const leaving = await add(checking, { kind: "transfer", accountId: broker })
    const split = await add(checking, { kind: "name", name: payee }, {
      splits: [
        { amount: -600, categoryId: leisure },
        { amount: -400, categoryId: null },
      ],
    })
    const lines = (await h.d1.prepare("SELECT id, category_id AS c FROM transactions WHERE parent_id = ? ORDER BY amount").bind(split).all<{ id: string }>())
      .results
    const rule = await create({
      conditionsOp: "or",
      conditions: [
        { field: "payee", op: "is", value: payee },
        { field: "payee", op: "is", value: "Livret" },
        { field: "payee", op: "is", value: "Courtier" },
      ],
      actions: [{ type: "set_category", categoryId: groceries }],
      enabled: false,
    })

    // Lines of an off-budget account are categorized too: nothing off budget counts anywhere.
    expect(await h.run(Rules.use((r) => r.applyToUncategorized(rule.id)))).toBe(3)
    expect({
      plain: await categoryOf(plain),
      offBudget: await categoryOf(offBudget),
      filed: await categoryOf(filed),
      internal: await categoryOf(internal),
      leaving: await categoryOf(leaving),
      split: await categoryOf(split),
      lines: [await categoryOf(lines[0]!.id), await categoryOf(lines[1]!.id)],
    }).toEqual({ plain: groceries, offBudget: groceries, filed: leisure, internal: null, leaving: null, split: null, lines: [leisure, groceries] })
    expect(await h.run(Rules.use((r) => r.applyToUncategorized(rule.id)))).toBe(0)
  })

  it("refuses to apply a rule that does not exist", async () => {
    expect(await h.fail(Rules.use((r) => r.applyToUncategorized("missing")))).toMatchObject({ _tag: "NotFound" })
  })
})

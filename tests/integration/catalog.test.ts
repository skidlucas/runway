import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Budget } from "~/server/services/budget"
import { Categories } from "~/server/services/categories"
import { Payees } from "~/server/services/payees"
import { Rules } from "~/server/services/rules"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

describe("Deleting and merging", () => {
  let h: Harness
  let account: string

  beforeAll(async () => {
    h = await createHarness()
    account = await h.run(
      Accounts.use((a) => a.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2026-01-01" })),
    )
  }, 60_000)
  afterAll(() => h?.dispose())

  it("deletes a group of many categories, moving history, budgets and rules to the replacement", async () => {
    const keep = await h.run(Categories.use((c) => c.createGroup({ name: "Garder" })))
    const target = await h.run(Categories.use((c) => c.create({ groupId: keep.id, name: "Divers" })))
    const doomed = await h.run(Categories.use((c) => c.createGroup({ name: "Supprimer" })))
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push((await h.run(Categories.use((c) => c.create({ groupId: doomed.id, name: `Vieille ${i}` })))).id)
    for (const id of ids.slice(0, 3)) await h.run(Budget.use((b) => b.setAmount("2026-09", id, 1_000)))
    await h.run(
      Transactions.use((t) => t.create({ accountId: account, date: "2026-09-02", amount: -500, payee: { kind: "name", name: "Kiosque" }, categoryId: ids[5]! })),
    )
    const rule = await h.run(
      Rules.use((r) =>
        r.create({ conditionsOp: "and", conditions: [{ field: "payee", op: "is", value: "Kiosque" }], actions: [{ type: "set_category", categoryId: ids[5]! }] }),
      ),
    )

    await h.run(Categories.use((c) => c.deleteGroup(doomed.id, target.id)))

    const tree = await h.run(Categories.use((c) => c.tree))
    expect(tree.some((g) => g.id === doomed.id)).toBe(false)
    const month = await h.run(Budget.use((b) => b.month("2026-09")))
    const divers = month.groups.flatMap((g) => g.categories).find((c) => c.id === target.id)!
    expect(divers.budgeted).toBe(3_000)
    expect(divers.spent).toBe(500)
    const rules = await h.run(Rules.use((r) => r.list))
    expect(rules.find((r) => r.id === rule.id)!.actions).toEqual([{ type: "set_category", categoryId: target.id }])
  })

  it("merges payees and points their rules at the survivor", async () => {
    const names = await h.run(Payees.use((p) => p.resolveNames(["Carrefour", "CARREFOUR MARKET", "Carrefour City"])))
    const [target, ...sources] = [...names.values()] as [string, ...string[]]
    const rule = await h.run(
      Rules.use((r) =>
        r.create({ conditionsOp: "and", conditions: [{ field: "imported_payee", op: "contains", value: "CRF" }], actions: [{ type: "set_payee", payeeId: sources[0]! }] }),
      ),
    )
    await h.run(Payees.use((p) => p.merge(sources, target)))
    const remaining = await h.run(Payees.use((p) => p.list))
    expect(remaining.filter((p) => p.name.toLowerCase().startsWith("carrefour")).map((p) => p.id)).toEqual([target])
    const rules = await h.run(Rules.use((r) => r.list))
    expect(rules.find((r) => r.id === rule.id)!.actions).toEqual([{ type: "set_payee", payeeId: target }])

    // The survivor is kept by deleteUnused because a rule still names it.
    await h.run(Payees.use((p) => p.deleteUnused))
    expect((await h.run(Payees.use((p) => p.list))).some((p) => p.id === target)).toBe(true)
  })
})

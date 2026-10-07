import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Categories } from "~/server/services/categories"
import { Entries } from "~/server/services/entries"
import { Rules } from "~/server/services/rules"
import { Schedules } from "~/server/services/schedules"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

const NOW = "2026-10-04T10:00:00Z"
const LATER = "2026-10-20T10:00:00Z"

describe("Entries", () => {
  let h: Harness
  let checking: string
  let savings: string
  let broker: string
  let groceries: string
  let leisure: string

  beforeAll(async () => {
    h = await createHarness({ now: NOW })
    await h.run(Categories.use((c) => c.createStarterSet))
    ;[groceries, leisure] = (await h.run(Categories.use((c) => c.tree))).filter((g) => !g.isIncome).flatMap((g) => g.categories.map((c) => c.id)) as [
      string,
      string,
    ]
    const account = (name: string, offBudget: boolean) =>
      h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget, startingBalance: 100_000, startingDate: "2026-01-01" })))
    checking = await account("Courant", false)
    savings = await account("Livret", false)
    broker = await account("Courtier", true)
  }, 60_000)
  afterAll(() => h?.dispose())

  const schedule = async (id: string) => (await h.run(Schedules.use((s) => s.list))).find((s) => s.id === id)
  const transaction = (id: string) => h.d1.prepare("SELECT id, account_id AS accountId FROM transactions WHERE id = ?").bind(id).first()
  /** Writes an operation dated after today, as the app allowed before such dates became schedules. */
  const legacy = async (input: Parameters<Transactions["Service"]["create"]>[0]) => {
    h.setNow(LATER)
    try {
      return await h.run(Transactions.use((t) => t.create(input)))
    } finally {
      h.setNow(NOW)
    }
  }

  it("records an operation of today or before as a transaction", async () => {
    const recorded = await h.run(
      Entries.use((e) => e.record({ accountId: checking, date: "2026-10-04", amount: -1_000, payee: { kind: "name", name: "Boulangerie" } })),
    )
    expect(recorded.kind).toBe("transaction")
    expect(await transaction(recorded.id)).not.toBeNull()
  })

  it("records a future operation as a manual one-off schedule, categorized like a transaction", async () => {
    await h.run(
      Rules.use((r) =>
        r.create({
          conditionsOp: "and",
          conditions: [{ field: "payee", op: "is", value: "Cinéma" }],
          actions: [{ type: "set_category", categoryId: leisure }],
        }),
      ),
    )
    const recorded = await h.run(
      Entries.use((e) => e.record({ accountId: checking, date: "2026-10-09", amount: -1_200, payee: { kind: "name", name: "Cinéma" }, notes: "Avant-première" })),
    )
    expect(recorded).toMatchObject({ kind: "schedule", date: "2026-10-09" })
    expect(await transaction(recorded.id)).toBeNull()
    expect(await schedule(recorded.id)).toMatchObject({
      name: null,
      payeeName: "Cinéma",
      accountId: checking,
      categoryId: leisure,
      amount: -1_200,
      notes: "Avant-première",
      recurrence: { unit: "once", interval: 1 },
      nextDate: "2026-10-09",
      autoPost: false,
    })
  })

  it("records a future transfer as a schedule paying the other account", async () => {
    const recorded = await h.run(
      Entries.use((e) => e.record({ accountId: checking, date: "2026-10-10", amount: -5_000, payee: { kind: "transfer", accountId: savings } })),
    )
    const planned = await schedule(recorded.id)
    expect(planned).toMatchObject({ accountId: checking, amount: -5_000 })
    expect(planned?.payeeName).toBe("Livret")
  })

  it("refuses a future split", async () => {
    const error = await h.fail(
      Entries.use((e) =>
        e.record({
          accountId: checking,
          date: "2026-10-10",
          amount: -3_000,
          payee: { kind: "none" },
          splits: [
            { amount: -2_000, categoryId: groceries },
            { amount: -1_000, categoryId: leisure },
          ],
        }),
      ),
    )
    expect(error).toMatchObject({ _tag: "Invalid" })
  })

  it("refuses a future date anywhere but through Entries", async () => {
    const id = await h.run(Transactions.use((t) => t.create({ accountId: checking, date: "2026-10-01", amount: -500, payee: { kind: "none" } })))
    expect(await h.fail(Transactions.use((t) => t.create({ accountId: checking, date: "2026-10-05", amount: -500, payee: { kind: "none" } })))).toMatchObject({
      _tag: "Invalid",
    })
    expect(await h.fail(Transactions.use((t) => t.update(id, { date: "2026-10-05" })))).toMatchObject({ _tag: "Invalid" })
  })

  it("keeps an edit dated today or before on the transaction", async () => {
    const id = await h.run(Transactions.use((t) => t.create({ accountId: checking, date: "2026-10-01", amount: -500, payee: { kind: "none" } })))
    expect(await h.run(Entries.use((e) => e.amend(id, { date: "2026-10-03", amount: -700 })))).toEqual({ kind: "transaction", id })
  })

  it("turns an operation moved after today into a schedule, with the edit applied", async () => {
    const id = await h.run(
      Transactions.use((t) =>
        t.create({ accountId: checking, date: "2026-10-02", amount: -2_000, payee: { kind: "name", name: "Plombier" }, categoryId: groceries, notes: "Fuite" }),
      ),
    )
    const recorded = await h.run(Entries.use((e) => e.amend(id, { date: "2026-10-12", amount: -2_500 })))
    expect(recorded).toMatchObject({ kind: "schedule", date: "2026-10-12" })
    expect(await transaction(id)).toBeNull()
    expect(await schedule(recorded.id)).toMatchObject({
      payeeName: "Plombier",
      accountId: checking,
      categoryId: groceries,
      amount: -2_500,
      notes: "Fuite",
      nextDate: "2026-10-12",
      autoPost: false,
    })
  })

  it("plans a moved transfer from its budget side and removes both sides", async () => {
    const id = await h.run(
      Transactions.use((t) => t.create({ accountId: checking, date: "2026-10-02", amount: -4_000, payee: { kind: "transfer", accountId: broker }, categoryId: groceries })),
    )
    const mirror = (await h.run(Transactions.use((t) => t.get(id)))).transferId!
    const recorded = await h.run(Entries.use((e) => e.amend(mirror, { date: "2026-10-15" })))
    expect([await transaction(id), await transaction(mirror)]).toEqual([null, null])
    expect(await schedule(recorded.id)).toMatchObject({ accountId: checking, amount: -4_000, categoryId: groceries, payeeName: "Courtier" })
  })

  it("refuses to move a split or a reconciled operation after today", async () => {
    const split = await h.run(
      Transactions.use((t) =>
        t.create({
          accountId: checking,
          date: "2026-10-02",
          amount: -3_000,
          payee: { kind: "none" },
          splits: [
            { amount: -2_000, categoryId: groceries },
            { amount: -1_000, categoryId: leisure },
          ],
        }),
      ),
    )
    expect(await h.fail(Entries.use((e) => e.amend(split, { date: "2026-10-12" })))).toMatchObject({ _tag: "Invalid" })

    const account = await h.run(
      Accounts.use((a) => a.create({ name: "Rapproché", kind: "checking", offBudget: false, startingBalance: 1_000, startingDate: "2026-01-01" })),
    )
    const reconciled = await h.run(Transactions.use((t) => t.create({ accountId: account, date: "2026-10-02", amount: -100, payee: { kind: "none" }, cleared: true })))
    await h.run(Accounts.use((a) => a.reconcile(account, 900)))
    expect(await h.fail(Entries.use((e) => e.amend(reconciled, { date: "2026-10-12" })))).toMatchObject({ _tag: "Invalid" })
  })

  it("converts the operations already dated after today, once, keeping splits", async () => {
    const simple = await legacy({ accountId: checking, date: "2026-10-18", amount: -900, payee: { kind: "name", name: "Dentiste" }, categoryId: groceries })
    const transfer = await legacy({ accountId: savings, date: "2026-10-19", amount: 3_000, payee: { kind: "transfer", accountId: checking } })
    const outgoing = (await h.run(Transactions.use((t) => t.get(transfer)))).transferId!
    const split = await legacy({
      accountId: checking,
      date: "2026-10-18",
      amount: -3_000,
      payee: { kind: "none" },
      splits: [
        { amount: -2_000, categoryId: groceries },
        { amount: -1_000, categoryId: leisure },
      ],
    })

    expect((await h.run(Schedules.use((s) => s.sync))).converted).toBe(2)
    expect(await schedule(simple)).toMatchObject({ payeeName: "Dentiste", amount: -900, categoryId: groceries, nextDate: "2026-10-18", autoPost: false })
    // A transfer between budget accounts is planned from the side money leaves.
    expect(await schedule(outgoing)).toMatchObject({ accountId: checking, amount: -3_000, payeeName: "Livret" })
    expect([await transaction(simple), await transaction(transfer), await transaction(outgoing)]).toEqual([null, null, null])
    expect(await transaction(split)).not.toBeNull()
    expect(await schedule(split)).toBeUndefined()

    expect((await h.run(Schedules.use((s) => s.sync))).converted).toBe(0)
  })
})

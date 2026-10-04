import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Accounts } from "~/server/services/accounts"
import { Schedules, type ScheduleInput } from "~/server/services/schedules"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

// Today is 2026-10-04 in every test of this file.
const NOW = "2026-10-04T10:00:00Z"

const setup = () => {
  let h: Harness
  let account: string
  let other: string
  const input = (startDate: string, extra: Partial<ScheduleInput> = {}): ScheduleInput => ({
    name: "Échéance",
    payee: { kind: "name", name: "Fournisseur" },
    accountId: account,
    categoryId: null,
    amount: -10_000,
    recurrence: { unit: "month", interval: 1 },
    startDate,
    autoPost: false,
    ...extra,
  })
  const create = (startDate: string, extra: Partial<ScheduleInput> = {}) => h.run(Schedules.use((s) => s.create(input(startDate, extra))))
  const schedule = async (id: string) => (await h.run(Schedules.use((s) => s.list))).find((s) => s.id === id)!
  const booked = async (id: string) =>
    (await h.d1.prepare("SELECT id, date FROM transactions WHERE schedule_id = ? ORDER BY date").bind(id).all<{ id: string; date: string }>()).results
  const pay = (payee: string, date: string, amount: number, accountId = account) =>
    h.run(Transactions.use((t) => t.create({ accountId, date, amount, payee: { kind: "name", name: payee }, categoryId: null })))

  beforeAll(async () => {
    h = await createHarness({ now: NOW })
    const open = (name: string) =>
      h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2026-01-01" })))
    account = await open("Courant")
    other = await open("Livret")
  }, 60_000)
  afterAll(() => h?.dispose())

  return {
    get h() {
      return h
    },
    get other() {
      return other
    },
    input,
    create,
    schedule,
    booked,
    pay,
  }
}

describe("Schedule edits", () => {
  const t = setup()

  it("skips the next occurrence without booking it, and ends on the last one", async () => {
    const id = await t.create("2026-10-04", { endDate: "2026-11-04" })
    await t.h.run(Schedules.use((s) => s.skip(id)))
    expect(await t.schedule(id)).toMatchObject({ nextDate: "2026-11-04", active: true })
    await t.h.run(Schedules.use((s) => s.skip(id)))
    expect(await t.schedule(id)).toMatchObject({ nextDate: "2026-11-05", active: false })
    await t.h.run(Schedules.use((s) => s.skip(id)))
    expect(await t.schedule(id)).toMatchObject({ nextDate: "2026-11-05", active: false })
    expect(await t.booked(id)).toEqual([])
  })

  it("refuses dates, amounts and rhythms it cannot use, on creation and on edit", async () => {
    const id = await t.create("2026-10-20")
    const bad: Array<Partial<ScheduleInput>> = [
      { startDate: "2026-02-30" },
      { endDate: "2026-13-01" },
      { endDate: "2026-10-19" },
      { amount: 0 },
      { amount: -10.5 },
      { recurrence: { unit: "month", interval: 0 } },
      { recurrence: { unit: "week", interval: 1.5 } },
    ]
    for (const extra of bad) {
      const label = JSON.stringify(extra)
      expect(await t.h.fail(Schedules.use((s) => s.create(t.input("2026-10-20", extra)))), label).toMatchObject({ _tag: "Invalid" })
      expect(await t.h.fail(Schedules.use((s) => s.update(id, t.input("2026-10-20", extra)))), label).toMatchObject({ _tag: "Invalid" })
    }
    expect(await t.schedule(id)).toMatchObject({ startDate: "2026-10-20", amount: -10_000, endDate: null })
  })

  it("restarts from the first occurrence still ahead when the rhythm changes", async () => {
    const id = await t.create("2026-07-15")
    expect((await t.schedule(id)).nextDate).toBe("2026-07-15")
    await t.h.run(Schedules.use((s) => s.update(id, t.input("2026-07-15", { recurrence: { unit: "week", interval: 1 } }))))
    expect((await t.schedule(id)).nextDate).toBe("2026-10-07")
    await t.h.run(Schedules.use((s) => s.update(id, t.input("2026-12-01", { recurrence: { unit: "week", interval: 1 } }))))
    expect((await t.schedule(id)).nextDate).toBe("2026-12-01")
  })
})

describe("Schedule payments matching", () => {
  const t = setup()
  const sync = () => t.h.run(Schedules.use((s) => s.sync))

  it("takes a payment up to 10 % away from the amount, and no further", async () => {
    const near = await t.create("2026-10-02", { payee: { kind: "name", name: "Électricien" } })
    const far = await t.create("2026-10-02", { payee: { kind: "name", name: "Plombier" } })
    const paid = await t.pay("Électricien", "2026-10-02", -11_000)
    await t.pay("Plombier", "2026-10-02", -11_001)
    await sync()
    expect((await t.booked(near)).map((b) => b.id)).toEqual([paid])
    expect(await t.booked(far)).toEqual([])
    expect((await t.schedule(far)).nextDate).toBe("2026-10-02")
  })

  it("allows 1 € at least on small amounts", async () => {
    const near = await t.create("2026-10-02", { payee: { kind: "name", name: "Boulangerie" }, amount: -500 })
    const far = await t.create("2026-10-02", { payee: { kind: "name", name: "Presse" }, amount: -500 })
    await t.pay("Boulangerie", "2026-10-02", -600)
    await t.pay("Presse", "2026-10-02", -601)
    await sync()
    expect(await t.booked(near)).toHaveLength(1)
    expect(await t.booked(far)).toEqual([])
  })

  it("takes a payment up to 6 days from the due date, and only on the schedule's account", async () => {
    const early = await t.create("2026-10-03", { payee: { kind: "name", name: "Garage" } })
    const late = await t.create("2026-09-26", { payee: { kind: "name", name: "Dentiste" } })
    const elsewhere = await t.create("2026-10-03", { payee: { kind: "name", name: "Crèche" } })
    await t.pay("Garage", "2026-09-27", -10_000)
    await t.pay("Dentiste", "2026-10-03", -10_000)
    await t.pay("Crèche", "2026-10-03", -10_000, t.other)
    await sync()
    expect((await t.booked(early)).map((b) => b.date)).toEqual(["2026-09-27"])
    expect(await t.booked(late)).toEqual([])
    expect(await t.booked(elsewhere)).toEqual([])
  })
})

describe("Schedule catch-up", () => {
  const t = setup()

  it("books 40 occurrences per sync and catches up on the next ones", async () => {
    const id = await t.create("2026-08-01", { recurrence: { unit: "day", interval: 1 }, autoPost: true })
    expect(await t.h.run(Schedules.use((s) => s.sync))).toEqual({ posted: 40, matched: 0 })
    expect((await t.schedule(id)).nextDate).toBe("2026-09-10")
    expect(await t.h.run(Schedules.use((s) => s.sync))).toEqual({ posted: 25, matched: 0 })
    expect((await t.schedule(id)).nextDate).toBe("2026-10-05")
    expect(await t.h.run(Schedules.use((s) => s.sync))).toEqual({ posted: 0, matched: 0 })
    const dates = (await t.booked(id)).map((b) => b.date)
    expect([dates.length, new Set(dates).size, dates[0], dates.at(-1)]).toEqual([65, 65, "2026-08-01", "2026-10-04"])
  })
})

import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addDays, addMonths, lastDay, todayIn } from "~/domain/dates"
import { Accounts } from "~/server/services/accounts"
import { ForecastService } from "~/server/services/forecast"
import { Schedules, type ScheduleInput } from "~/server/services/schedules"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

const today = todayIn("Europe/Paris")

describe("Schedules", () => {
  let h: Harness
  let account: string
  let other: string

  const booked = async (scheduleId: string) => {
    const { results } = await h.d1
      .prepare("SELECT date FROM transactions WHERE schedule_id = ? ORDER BY date")
      .bind(scheduleId)
      .all<{ date: string }>()
    return results.map((r) => r.date)
  }
  const schedule = (id: string) => h.run(Schedules.use((s) => s.list)).then((all) => all.find((s) => s.id === id)!)
  const monthly = (startDate: string, extra: Partial<ScheduleInput> = {}): ScheduleInput => ({
    name: "Loyer",
    payee: { kind: "name", name: "Propriétaire" },
    accountId: account,
    categoryId: null,
    amount: -80_000,
    recurrence: { unit: "month", interval: 1 },
    startDate,
    autoPost: true,
    ...extra,
  })

  beforeAll(async () => {
    h = await createHarness()
    const create = (name: string) =>
      h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2020-01-01" })))
    account = await create("Courant")
    other = await create("Livret")
  }, 60_000)
  afterAll(() => h?.dispose())

  it("links a manual schedule to the payment entered by hand, and leaves unpaid ones due", async () => {
    const due = addDays(today, -2)
    const paid = await h.run(
      Schedules.use((s) => s.create(monthly(due, { name: "Club", payee: { kind: "name", name: "Club de sport" }, accountId: other, amount: -3_000, autoPost: false }))),
    )
    const unpaid = await h.run(
      Schedules.use((s) => s.create(monthly(due, { name: "Cours", payee: { kind: "name", name: "Cours de piano" }, accountId: other, amount: -9_000, autoPost: false }))),
    )
    await h.run(
      Transactions.use((t) => t.create({ accountId: other, date: addDays(due, 1), amount: -3_100, payee: { kind: "name", name: "Club de sport" }, categoryId: null })),
    )
    const result = await h.run(Schedules.use((s) => s.sync))
    expect(result.matched).toBe(1)
    expect(await booked(paid)).toEqual([addDays(due, 1)])
    expect((await schedule(paid)).nextDate > today).toBe(true)
    expect(await booked(unpaid)).toEqual([])
    expect((await schedule(unpaid)).nextDate).toBe(due)
  })

  it("counts every unpaid occurrence of a schedule that is several periods late", async () => {
    const weekly = (start: string) =>
      monthly(start, { name: "Ménage", payee: { kind: "name", name: "Femme de ménage" }, amount: -5_000, autoPost: false, recurrence: { unit: "week", interval: 1 } })
    const late = await h.run(Schedules.use((s) => s.create(weekly(addDays(today, -20)))))
    const forgotten = await h.run(Schedules.use((s) => s.create({ ...weekly(addDays(today, -400)), recurrence: { unit: "day", interval: 1 } })))
    const occurrences = await h.run(Schedules.use((s) => s.occurrences(today, today)))
    const overdue = (id: string) => occurrences.filter((o) => o.scheduleId === id && o.overdue)
    expect(overdue(late).map((o) => o.dueDate)).toEqual([addDays(today, -20), addDays(today, -13), addDays(today, -6)])
    expect(overdue(late).every((o) => o.date === today)).toBe(true)
    expect(overdue(forgotten)).toHaveLength(12)
    await h.run(Schedules.use((s) => Effect.all([s.remove(late), s.remove(forgotten)])))
  })

  it("books a due occurrence once, even when two syncs run at the same time", async () => {
    const id = await h.run(Schedules.use((s) => s.create(monthly(today))))
    await h.run(Effect.all([Schedules.use((s) => s.sync), Schedules.use((s) => s.sync)], { concurrency: "unbounded" }))
    expect(await booked(id)).toEqual([today])
    expect((await schedule(id)).nextDate > today).toBe(true)
  })

  it("does not book past occurrences again when an end date is added", async () => {
    const start = `${addMonths(today.slice(0, 7), -4)}-15`
    const id = await h.run(Schedules.use((s) => s.create(monthly(start, { name: "Abonnement" }))))
    await h.run(Schedules.use((s) => s.sync))
    const before = await booked(id)
    expect(before.length).toBeGreaterThanOrEqual(4)

    await h.run(Schedules.use((s) => s.update(id, monthly(start, { name: "Abonnement", endDate: addDays(start, 40) }))))
    await h.run(Schedules.use((s) => s.sync))
    expect(await booked(id)).toEqual(before)
    expect((await schedule(id)).active).toBe(false)
  })

  it("keeps an overdue occurrence and its day of month when edited", async () => {
    const start = lastDay(addMonths(today.slice(0, 7), -3))
    const id = await h.run(Schedules.use((s) => s.create(monthly(start, { name: "Manuel", autoPost: false }))))
    const current = await schedule(id)
    await h.run(Schedules.use((s) => s.update(id, monthly(current.startDate, { name: "Manuel renommé", autoPost: false }))))
    const edited = await schedule(id)
    expect(edited.nextDate).toBe(current.nextDate)
    expect(edited.startDate).toBe(start)
  })

  it("refuses a transfer to its own account, and one broken schedule does not stop the others", async () => {
    await expect(
      h.run(Schedules.use((s) => s.create(monthly(today, { payee: { kind: "transfer", accountId: account } })))),
    ).rejects.toThrow("Un virement doit viser un autre compte")

    const broken = await h.run(Schedules.use((s) => s.create(monthly(today, { name: "Cassée", payee: { kind: "transfer", accountId: other } }))))
    // Corrupt it behind the service's back, as an old import could have.
    await h.d1.prepare("UPDATE schedules SET account_id = ? WHERE id = ?").bind(other, broken).run()
    const healthy = await h.run(Schedules.use((s) => s.create(monthly(today, { name: "Saine", payee: { kind: "name", name: "Assureur" } }))))

    const result = await h.run(Schedules.use((s) => s.sync))
    expect(result.posted).toBeGreaterThanOrEqual(1)
    expect(await booked(healthy)).toEqual([today])
    expect(await booked(broken)).toEqual([])
  })

  it("counts transfer schedules in the forecast only when money leaves or enters it", async () => {
    const savings = await h.run(
      Accounts.use((a) => a.create({ name: "Livret A", kind: "savings", offBudget: false, startingBalance: 0, startingDate: "2020-01-01" })),
    )
    const later = addDays(today, 3) > lastDay(today.slice(0, 7)) ? today : addDays(today, 3)
    const between = await h.run(
      Schedules.use((s) => s.create(monthly(later, { name: "Entre comptes courants", autoPost: false, payee: { kind: "transfer", accountId: other } }))),
    )
    const out = await h.run(
      Schedules.use((s) => s.create(monthly(later, { name: "Vers le livret", autoPost: false, payee: { kind: "transfer", accountId: savings } }))),
    )
    const back = await h.run(
      Schedules.use((s) =>
        s.create(monthly(later, { name: "Depuis le livret", autoPost: false, accountId: savings, payee: { kind: "transfer", accountId: account } })),
      ),
    )
    const forecast = await h.run(ForecastService.use((f) => f.month()))
    const amounts = new Map(forecast.upcoming.filter((u) => u.scheduleId).map((u) => [u.scheduleId, u.amount]))
    expect(amounts.has(between)).toBe(false)
    expect(amounts.get(out)).toBe(-80_000)
    expect(amounts.get(back)).toBe(80_000)
  })

  it("books a one-off schedule once and then ends it", async () => {
    const id = await h.run(Schedules.use((s) => s.create(monthly(today, { name: "Remboursement", recurrence: { unit: "once", interval: 1 } }))))
    await h.run(Schedules.use((s) => s.sync))
    await h.run(Schedules.use((s) => s.sync))
    expect(await booked(id)).toEqual([today])
    expect((await schedule(id)).active).toBe(false)
  })

  it("keeps a one-off moved to a past day due", async () => {
    const once = { recurrence: { unit: "once" as const, interval: 1 }, autoPost: false }
    const id = await h.run(Schedules.use((s) => s.create(monthly(addDays(today, 10), { name: "Ponctuel", ...once }))))
    await h.run(Schedules.use((s) => s.update(id, monthly(addDays(today, -3), { name: "Ponctuel", ...once }))))
    expect(await schedule(id)).toMatchObject({ active: true, nextDate: addDays(today, -3) })
  })

  it("books an occurrence on the day asked for", async () => {
    const id = await h.run(Schedules.use((s) => s.create(monthly(addDays(today, 5), { name: "Futur", autoPost: false }))))
    await h.run(Schedules.use((s) => s.post(id, addDays(today, 5))))
    expect(await booked(id)).toEqual([addDays(today, 5)])
  })

  it("lists what is coming on the forecast accounts", async () => {
    const next = await h.run(ForecastService.use((f) => f.upcoming({ days: 7 })))
    expect(next.items.some((i) => i.date === addDays(today, 5) && i.source === "transaction")).toBe(true)
  })

  it("refuses to forecast a month that has not started", async () => {
    expect(await h.fail(ForecastService.use((f) => f.month({ month: addMonths(today.slice(0, 7), 1) })))).toMatchObject({
      _tag: "Invalid",
      message: "La prévision commence au mois en cours",
    })
  })

  it("forecasts one account from its schedules and lists the next days", async () => {
    const checking = await h.run(
      Accounts.use((a) => a.create({ name: "Perso", kind: "checking", offBudget: false, startingBalance: 200_000, startingDate: "2020-01-01" })),
    )
    const livret = await h.run(
      Accounts.use((a) => a.create({ name: "Livret perso", kind: "savings", offBudget: false, startingBalance: 500_000, startingDate: "2020-01-01" })),
    )
    const soon = addDays(today, 2)
    const sameMonth = soon.slice(0, 7) === today.slice(0, 7)
    await h.run(
      Schedules.use((s) =>
        s.create(monthly(soon, { name: "Vers livret perso", accountId: checking, autoPost: false, payee: { kind: "transfer", accountId: livret } })),
      ),
    )
    await h.run(
      Schedules.use((s) =>
        s.create(monthly(soon, { name: "Assurance", accountId: checking, autoPost: false, recurrence: { unit: "once", interval: 1 } })),
      ),
    )

    const perso = await h.run(ForecastService.use((f) => f.month({ accountId: checking })))
    expect(perso.accountId).toBe(checking)
    expect(perso.accounts.map((a) => a.id)).toEqual([checking])
    expect(perso.balanceToday).toBe(200_000)
    expect(perso.projectedEndBalance).toBe(200_000 - (sameMonth ? 160_000 : 0))

    const saving = await h.run(ForecastService.use((f) => f.month({ accountId: livret })))
    // The transfer leaves the checking account and lands on the savings account.
    expect(saving.projectedEndBalance).toBe(500_000 + (sameMonth ? 80_000 : 0))

    const next = await h.run(ForecastService.use((f) => f.upcoming({ accountId: checking, days: 7 })))
    expect(next.items.map((i) => [i.name, i.date, i.amount]).sort()).toEqual([
      ["Assurance", soon, -80_000],
      ["Vers livret perso", soon, -80_000],
    ])
    expect(await h.fail(ForecastService.use((f) => f.month({ accountId: "nope" })))).toMatchObject({ _tag: "NotFound" })
  })

  it("resumes an ended schedule after its last booked occurrence when its end date moves later", async () => {
    const start = `${addMonths(today.slice(0, 7), -3)}-10`
    const end = `${addMonths(today.slice(0, 7), -2)}-10`
    const input = monthly(start, { name: "Crédit", endDate: end })
    const id = await h.run(Schedules.use((s) => s.create(input)))
    await h.run(Schedules.use((s) => s.sync))
    expect(await booked(id)).toEqual([start, end])
    expect((await schedule(id)).active).toBe(false)

    await h.run(Schedules.use((s) => s.update(id, { ...input, endDate: addDays(today, 400) })))
    expect(await schedule(id)).toMatchObject({ active: true, nextDate: `${addMonths(today.slice(0, 7), -1)}-10` })
  })

  it("stays paused when edited", async () => {
    const input = monthly(addDays(today, 5), { name: "En pause", autoPost: false })
    const id = await h.run(Schedules.use((s) => s.create(input)))
    await h.run(Schedules.use((s) => s.update(id, { ...input, active: false })))
    await h.run(Schedules.use((s) => s.update(id, { ...input, name: "Toujours en pause" })))
    expect((await schedule(id)).active).toBe(false)
  })

  it("never books or forecasts a stored rhythm it cannot read, and still lists it to be fixed", async () => {
    const id = await h.run(Schedules.use((s) => s.create(monthly(addDays(today, 3), { name: "Rythme abîmé" }))))
    await h.d1.prepare(`UPDATE schedules SET recurrence = '{"unit":"fortnight","interval":1}' WHERE id = ?`).bind(id).run()
    try {
      expect(await schedule(id)).toMatchObject({ active: false, recurrenceLabel: "Rythme illisible, à redéfinir" })
      const forecast = await h.run(ForecastService.use((f) => f.upcoming({ days: 30 })))
      expect(forecast.items.some((i) => i.scheduleId === id)).toBe(false)
      await h.d1.prepare("UPDATE schedules SET next_date = ? WHERE id = ?").bind(today, id).run()
      await h.run(Schedules.use((s) => s.sync))
      expect(await booked(id)).toEqual([])
      expect(await h.fail(Schedules.use((s) => s.post(id)))).toMatchObject({ _tag: "Invalid" })
    } finally {
      await h.run(Schedules.use((s) => s.remove(id)))
    }
  })
})

import { Effect } from "effect"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { addDays, addMonths, lastDay } from "~/domain/dates"
import { Accounts } from "~/server/services/accounts"
import { ForecastService } from "~/server/services/forecast"
import { Schedules, type ScheduleInput } from "~/server/services/schedules"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

const NOW = "2026-10-04T10:00:00Z"
const today = "2026-10-04"

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
    h = await createHarness({ now: NOW })
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

  it("refuses a transfer to an account that does not exist", async () => {
    expect(await h.fail(Schedules.use((s) => s.create(monthly(today, { payee: { kind: "transfer", accountId: "nope" } }))))).toMatchObject({
      _tag: "NotFound",
      entity: "Compte",
    })
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

  it("books an occurrence not due yet on today, never on a future day", async () => {
    const id = await h.run(Schedules.use((s) => s.create(monthly(addDays(today, 5), { name: "Futur", autoPost: false }))))
    expect(await h.fail(Schedules.use((s) => s.post(id, addDays(today, 5))))).toMatchObject({ _tag: "Invalid" })
    await h.run(Schedules.use((s) => s.post(id)))
    expect(await booked(id)).toEqual([today])
    expect((await schedule(id)).nextDate > addDays(today, 5)).toBe(true)
  })

  it("forecasts from the current month to twelve months ahead", async () => {
    const current = today.slice(0, 7)
    expect(await h.fail(ForecastService.use((f) => f.month({ month: addMonths(current, -1) })))).toMatchObject({
      _tag: "Invalid",
      message: "La prévision commence au mois en cours",
    })
    expect(await h.fail(ForecastService.use((f) => f.month({ month: addMonths(current, 13) })))).toMatchObject({
      _tag: "Invalid",
      message: "La prévision va jusqu'à 12 mois",
    })
    expect((await h.run(ForecastService.use((f) => f.month({ month: addMonths(current, 12) })))).isFuture).toBe(true)
  })

  it("opens a month yet to come on today's balance plus what is expected until its 1st", async () => {
    const perso = await h.run(
      Accounts.use((a) => a.create({ name: "Projeté", kind: "checking", offBudget: false, startingBalance: 300_000, startingDate: "2020-01-01" })),
    )
    const epargne = await h.run(
      Accounts.use((a) => a.create({ name: "Épargne projetée", kind: "savings", offBudget: false, startingBalance: 0, startingDate: "2020-01-01" })),
    )
    const current = today.slice(0, 7)
    const inTwoMonths = addMonths(current, 2)
    // On the 20th from next month on: two occurrences before the forecast month, one in it.
    await h.run(Schedules.use((s) => s.create(monthly(`${addMonths(current, 1)}-20`, { name: "Abonnement", accountId: perso, amount: -10_000, autoPost: false }))))
    await h.run(
      Schedules.use((s) =>
        s.create(monthly(`${addMonths(current, 1)}-20`, { name: "Vers épargne", accountId: perso, autoPost: false, payee: { kind: "transfer", accountId: epargne } })),
      ),
    )
    const once = { recurrence: { unit: "once" as const, interval: 1 }, accountId: perso, autoPost: false }
    await h.run(Schedules.use((s) => s.create(monthly(`${addMonths(current, 1)}-05`, { name: "Garage", amount: -5_000, ...once }))))
    await h.run(Schedules.use((s) => s.create(monthly(`${inTwoMonths}-05`, { name: "Garage", amount: -7_000, ...once }))))

    const f = await h.run(ForecastService.use((s) => s.month({ accountId: perso, month: inTwoMonths })))
    const opening = 300_000 - 5_000 - 10_000 - 80_000
    expect(f.isFuture).toBe(true)
    expect(f.balanceToday).toBe(opening)
    expect(f.upcoming.map((u) => [u.date, u.amount]).sort()).toEqual([
      [`${inTwoMonths}-05`, -7_000],
      [`${inTwoMonths}-20`, -10_000],
      [`${inTwoMonths}-20`, -80_000],
    ])
    expect(f.projectedEndBalance).toBe(opening - 7_000 - 10_000 - 80_000)

    // The transfer carried into the opening balance lands on the savings account.
    const saving = await h.run(ForecastService.use((s) => s.month({ accountId: epargne, month: inTwoMonths })))
    expect(saving.balanceToday).toBe(80_000)
    expect(saving.projectedEndBalance).toBe(160_000)
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

describe("Schedules sync cost", () => {
  let h: Harness
  let account: string
  let savings: string

  const input = (startDate: string, extra: Partial<ScheduleInput>): ScheduleInput => ({
    name: null,
    payee: { kind: "none" },
    accountId: account,
    categoryId: null,
    amount: -1_000,
    recurrence: { unit: "month", interval: 1 },
    startDate,
    autoPost: true,
    ...extra,
  })
  const create = (startDate: string, extra: Partial<ScheduleInput>) => h.run(Schedules.use((s) => s.create(input(startDate, extra))))
  const nextDate = async (id: string) =>
    (await h.d1.prepare("SELECT next_date AS d FROM schedules WHERE id = ?").bind(id).first<{ d: string }>())?.d

  // Each test gets its own database: a sync books whatever is due, and the cap of 40 is per sync.
  beforeEach(async () => {
    h = await createHarness({ now: NOW })
    const open = (name: string) =>
      h.run(Accounts.use((a) => a.create({ name, kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2020-01-01" })))
    account = await open("Courant")
    savings = await open("Épargne")
  }, 60_000)
  afterEach(() => h?.dispose())

  it("books 40 due occurrences and matches payments in a few queries, under the Workers limit", async () => {
    const weekly = await create(addDays(today, -63), { payee: { kind: "name", name: "Ménage" }, recurrence: { unit: "week", interval: 1 } })
    const named = await Promise.all(Array.from({ length: 20 }, (_, i) => create(today, { payee: { kind: "name", name: `Fournisseur ${i}` } })))
    const transfers = await Promise.all(
      Array.from({ length: 10 }, () => create(today, { payee: { kind: "transfer", accountId: savings }, name: "Épargne mensuelle" })),
    )
    const manual = await Promise.all(
      Array.from({ length: 5 }, (_, i) => create(addDays(today, -1), { payee: { kind: "name", name: `Club ${i}` }, autoPost: false })),
    )
    await Promise.all(
      manual.map((_, i) =>
        h.run(
          Transactions.use((t) => t.create({ accountId: account, date: today, amount: -1_000, payee: { kind: "name", name: `Club ${i}` }, categoryId: null })),
        ),
      ),
    )

    const { value, statements } = await h.statementsOf(Schedules.use((s) => s.sync))
    expect(value).toEqual({ posted: 40, matched: 5, converted: 0 })
    expect(statements).toBeLessThan(20)

    const count = async (where: string, ...params: string[]) =>
      (await h.d1.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`).bind(...params).first<{ n: number }>())?.n
    expect(await count("schedule_id = ?", weekly)).toBe(10)
    expect(await count("account_id = ? AND amount = 1000 AND transfer_id IS NOT NULL", savings)).toBe(10)
    for (const id of [...named, ...transfers, ...manual]) expect((await nextDate(id))! > today).toBe(true)

    expect(await h.run(Schedules.use((s) => s.sync))).toEqual({ posted: 0, matched: 0, converted: 0 })
  })

  it("leaves an occurrence due when its transaction cannot be written, and still books the others", async () => {
    const broken = await create(today, { name: "Panne", payee: { kind: "name", name: "Panne" } })
    const healthy = await create(today, { name: "Saine", payee: { kind: "name", name: "Saine" } })
    await h.d1
      .prepare("CREATE TRIGGER fail_panne BEFORE INSERT ON transactions WHEN NEW.notes = 'Panne' BEGIN SELECT RAISE(ABORT, 'panne'); END")
      .run()
    try {
      expect(await h.run(Schedules.use((s) => s.sync))).toEqual({ posted: 1, matched: 0, converted: 0 })
      expect(await nextDate(broken)).toBe(today)
      expect((await nextDate(healthy))! > today).toBe(true)
    } finally {
      await h.d1.prepare("DROP TRIGGER fail_panne").run()
    }
  })
})

describe("Schedule suggestions", () => {
  let h: Harness
  let other: string

  beforeAll(async () => {
    h = await createHarness({ now: NOW })
    other = await h.run(Accounts.use((a) => a.create({ name: "Carte", kind: "checking", offBudget: false, startingBalance: 0, startingDate: "2020-01-01" })))
  }, 60_000)
  afterAll(() => h?.dispose())

  it("suggests a payee paid every month, from its third payment on", async () => {
    const pay = (payee: string, monthsAgo: number) =>
      h.run(
        Transactions.use((t) =>
          t.create({ accountId: other, date: addDays(today, -30 * monthsAgo), amount: -1_399, payee: { kind: "name", name: payee } }),
        ),
      )
    for (const monthsAgo of [3, 2, 1]) await pay("Streaming", monthsAgo)
    for (const monthsAgo of [2, 1]) await pay("Salle de sport", monthsAgo)
    const suggested = (await h.run(Schedules.use((s) => s.suggestions))).map((c) => c.payeeName)
    expect(suggested).toContain("Streaming")
    expect(suggested).not.toContain("Salle de sport")
  })
})

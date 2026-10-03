import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addDays, addMonths, todayIn } from "~/domain/dates"
import { Accounts } from "~/server/services/accounts"
import { ForecastService } from "~/server/services/forecast"
import { Schedules, type ScheduleInput } from "~/server/services/schedules"
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
    const start = `${addMonths(today.slice(0, 7), -3)}-31`.replace(/-(02|04|06|09|11)-31$/, "-$1-30")
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
    const later = addDays(today, 3) > `${today.slice(0, 7)}-31` ? today : addDays(today, 3)
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
})

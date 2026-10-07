import { describe, expect, it } from "vitest"
import { computeForecast } from "~/domain/forecast"

describe("forecast", () => {
  const base = {
    today: "2026-10-02",
    month: "2026-10",
    dailyBalances: new Map([
      ["2026-10-01", 325674],
      ["2026-10-02", 321456],
    ]),
    openingBalance: 100000,
    upcoming: [],
  }

  it("projects today's balance when nothing is planned", () => {
    const f = computeForecast(base)
    expect(f.isFuture).toBe(false)
    expect(f.daysLeft).toBe(30)
    expect(f.balanceToday).toBe(321456)
    expect(f.projectedEndBalance).toBe(321456)
    expect(f.days).toHaveLength(31)
    expect(f.days[1]).toMatchObject({ kind: "today", balance: 321456 })
    expect(f.days[30]).toMatchObject({ kind: "future", balance: 321456 })
  })

  it("counts every scheduled expense, expected income and future operation on its day", () => {
    const f = computeForecast({
      ...base,
      upcoming: [
        { date: "2026-10-10", name: "Assurance", amount: -1850, categoryId: null, source: "schedule", scheduleId: "s1", overdue: false },
        { date: "2026-10-28", name: "Navigo", amount: -8640, categoryId: "transport", source: "schedule", scheduleId: "s2", overdue: false },
        { date: "2026-10-30", name: "Prime", amount: 50000, categoryId: null, source: "schedule", scheduleId: "s4", overdue: false },
        { date: "2026-10-05", name: "Chèque", amount: -2000, categoryId: "courses", source: "transaction", scheduleId: null, overdue: false },
      ],
    })
    expect(f.upcoming.map((u) => u.tag)).toEqual(["booked", "scheduled", "scheduled", "income"])
    expect(f.scheduledUpcoming).toBe(1850 + 8640)
    expect(f.upcomingIncome).toBe(50000)
    expect(f.bookedUpcoming).toBe(2000)
    expect(f.projectedEndBalance).toBe(321456 - 1850 - 8640 + 50000 - 2000)
    expect(f.days[4]).toMatchObject({ balance: 321456 - 2000, hasSchedule: true })
    expect(f.days[9]).toMatchObject({ balance: 321456 - 2000 - 1850, hasSchedule: true })
    expect(f.days[10]).toMatchObject({ balance: 321456 - 2000 - 1850, hasSchedule: false })
  })

  it("weighs what is due today from tomorrow on", () => {
    const f = computeForecast({
      ...base,
      upcoming: [{ date: "2026-10-02", name: "Loyer", amount: -80000, categoryId: null, source: "schedule", scheduleId: "s1", overdue: true }],
    })
    expect(f.days[1]).toMatchObject({ kind: "today", balance: 321456 })
    expect(f.days[2]).toMatchObject({ kind: "future", balance: 321456 - 80000 })
    expect(f.days[30]?.balance).toBe(f.projectedEndBalance)
  })

  it("projects every day of a month yet to come from the balance it opens with", () => {
    const f = computeForecast({
      ...base,
      month: "2026-12",
      dailyBalances: new Map(),
      openingBalance: 200000,
      upcoming: [
        { date: "2026-12-01", name: "Loyer", amount: -80000, categoryId: null, source: "schedule", scheduleId: "s1", overdue: false },
        { date: "2026-12-15", name: "Chèque", amount: -2000, categoryId: null, source: "transaction", scheduleId: null, overdue: false },
      ],
    })
    expect(f.isFuture).toBe(true)
    expect(f.today).toBe("2026-10-02")
    expect(f.daysLeft).toBe(31)
    expect(f.balanceToday).toBe(200000)
    expect(f.days.every((d) => d.kind === "future")).toBe(true)
    // What falls on the 1st weighs on the 1st, once.
    expect(f.days[0]).toMatchObject({ balance: 200000 - 80000, hasSchedule: true })
    expect(f.days[30]?.balance).toBe(200000 - 80000 - 2000)
    expect(f.projectedEndBalance).toBe(200000 - 80000 - 2000)
  })
})

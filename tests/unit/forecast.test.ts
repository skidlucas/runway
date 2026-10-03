import { describe, expect, it } from "vitest"
import { computeForecast, type ForecastCategory } from "~/domain/forecast"

const cat = (id: string, budgeted: number, spent: number, extra: Partial<ForecastCategory> = {}): ForecastCategory => ({
  id,
  name: id,
  isIncome: false,
  hidden: false,
  budgeted,
  spent,
  available: budgeted - spent,
  ...extra,
})

describe("forecast", () => {
  const base = {
    today: "2026-10-02",
    month: "2026-10",
    categories: [cat("courses", 42000, 28745), cat("transport", 9000, 10430), cat("loyer", 85000, 85000)],
    dailyBalances: new Map([
      ["2026-10-01", 325674],
      ["2026-10-02", 321456],
    ]),
    openingBalance: 100000,
    upcoming: [],
  }

  it("computes the remaining budget, per-day amount and projection", () => {
    const f = computeForecast(base)
    // Transport is overspent: it does not add negative "remaining".
    expect(f.remainingToSpend).toBe(42000 - 28745)
    expect(f.daysLeft).toBe(30)
    expect(f.perDay).toBe(Math.floor(13255 / 30))
    expect(f.balanceToday).toBe(321456)
    expect(f.projectedEndBalance).toBe(321456 - 13255)
    expect(f.days).toHaveLength(31)
    expect(f.days[1]).toMatchObject({ kind: "today", balance: 321456 })
    expect(f.days[30]).toMatchObject({ kind: "future", balance: 321456 - 13255 })
    expect(f.watch.map((w) => w.id)).toEqual(["transport"])
  })

  it("subtracts unbudgeted schedules, adds expected income, and leaves budgeted ones to the budget", () => {
    const f = computeForecast({
      ...base,
      upcoming: [
        { date: "2026-10-10", name: "Assurance", amount: -1850, categoryId: null, source: "schedule", scheduleId: "s1" },
        { date: "2026-10-28", name: "Navigo", amount: -8640, categoryId: "transport", source: "schedule", scheduleId: "s2" },
        { date: "2026-10-28", name: "Courses drive", amount: -3000, categoryId: "courses", source: "schedule", scheduleId: "s3" },
        { date: "2026-10-30", name: "Prime", amount: 50000, categoryId: null, source: "schedule", scheduleId: "s4" },
        { date: "2026-10-05", name: "Chèque", amount: -2000, categoryId: "courses", source: "transaction", scheduleId: null },
      ],
    })
    expect(f.upcoming.map((u) => u.tag.kind)).toEqual(["booked", "unbudgeted", "category", "category", "income"])
    // Navigo's category is budgeted (even if overspent), so it is covered by the budget.
    expect(f.unbudgetedUpcoming).toBe(1850)
    expect(f.upcomingIncome).toBe(50000)
    expect(f.bookedUpcoming).toBe(2000)
    expect(f.projectedEndBalance).toBe(321456 - 13255 - 1850 + 50000 - 2000)
  })

  it("has nothing left to spend in a past month", () => {
    const f = computeForecast({ ...base, month: "2026-09", dailyBalances: new Map([["2026-09-30", 5000]]) })
    expect(f.remainingToSpend).toBe(0)
    expect(f.daysLeft).toBe(0)
    expect(f.projectedEndBalance).toBe(5000)
  })
})

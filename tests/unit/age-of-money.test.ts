import { describe, expect, it } from "vitest"
import { ageOfMoney } from "~/domain/age-of-money"

describe("age of money", () => {
  it("spends the oldest money first", () => {
    const days = [
      { date: "2026-01-01", inflow: 1000, outflow: 0 },
      { date: "2026-01-11", inflow: 1000, outflow: 0 },
    ]
    // 1000 waited 20 days, 500 waited 10 days.
    expect(ageOfMoney(days, [{ date: "2026-01-21", amount: 1500 }])).toBe(17)
  })

  it("lets the earlier outflows consume money before the sampled ones", () => {
    const days = [
      { date: "2026-01-01", inflow: 1000, outflow: 0 },
      { date: "2026-01-05", inflow: 0, outflow: 800 },
      { date: "2026-01-11", inflow: 500, outflow: 0 },
    ]
    expect(ageOfMoney(days, [{ date: "2026-01-20", amount: 400 }])).toBe((200 * 19 + 200 * 9) / 400)
  })

  it("averages the sampled outflows and counts money received the same day", () => {
    const days = [{ date: "2026-01-01", inflow: 1000, outflow: 0 }, { date: "2026-01-31", inflow: 100, outflow: 0 }]
    const sample = [
      { date: "2026-01-11", amount: 100 },
      { date: "2026-01-31", amount: 900 },
      { date: "2026-01-31", amount: 100 },
    ]
    expect(ageOfMoney(days, sample)).toBe(Math.round((10 + 30 + 0) / 3))
  })

  it("has no age without money received", () => {
    expect(ageOfMoney([], [])).toBeNull()
    expect(ageOfMoney([], [{ date: "2026-01-01", amount: 100 }])).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import { cumulativeByDay, runningBalances, topWithRest } from "~/domain/reports"

describe("reports", () => {
  it("rolls monthly movements into month-end balances", () => {
    const movements = new Map([
      ["2026-08", 500],
      ["2026-10", -200],
    ])
    expect(runningBalances(1000, movements, ["2026-08", "2026-09", "2026-10"])).toEqual([
      { month: "2026-08", value: 1500 },
      { month: "2026-09", value: 1500 },
      { month: "2026-10", value: 1300 },
    ])
  })

  it("accumulates daily totals and stops after today", () => {
    const daily = new Map([
      ["2026-10-01", 100],
      ["2026-10-03", 50],
      ["2026-10-05", 999],
    ])
    expect(cumulativeByDay(daily, "2026-10", "2026-10-04")).toEqual([100, 100, 150, 150])
    expect(cumulativeByDay(new Map(), "2026-02")).toHaveLength(28)
  })

  it("keeps the largest rows and adds up the rest", () => {
    const rows = [10, 50, 30, 20, 40].map((amount) => ({ name: String(amount), amount }))
    const rest = (amount: number, count: number) => ({ name: `${count} autres`, amount })
    expect(topWithRest(rows, 2, rest)).toEqual([
      { name: "50", amount: 50 },
      { name: "40", amount: 40 },
      { name: "3 autres", amount: 60 },
    ])
    // A single leftover row is shown as itself rather than as "1 autre".
    expect(topWithRest(rows.slice(0, 3), 2, rest).map((r) => r.name)).toEqual(["50", "30", "10"])
  })
})

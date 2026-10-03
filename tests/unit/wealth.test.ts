import { describe, expect, it } from "vitest"
import {
  allocation,
  type AssetValues,
  latestOn,
  loanBalance,
  loanEndMonth,
  loanMonthlyPayment,
  loanPaymentsMade,
  relativeChange,
  retainedValueAt,
} from "~/domain/wealth"

const estimates = [
  { date: "2026-01-15", amount: 9_000_00 },
  { date: "2026-06-01", amount: 9_800_00 },
  { date: "2026-10-01", amount: 10_200_00 },
]

const watch = (retained: AssetValues["retained"]): AssetValues => ({
  purchase: { amount: 6_800_00, date: "2015-03-10" },
  declared: { amount: 9_500_00, date: "2026-06-12" },
  estimateAt: (day) => latestOn(estimates, day),
  retained,
})

describe("retainedValueAt", () => {
  it("uses the retained kind when it is known", () => {
    expect(retainedValueAt(watch("estimated"), "2026-10-03")).toEqual({ amount: 10_200_00, kind: "estimated" })
    expect(retainedValueAt(watch("declared"), "2026-10-03")).toEqual({ amount: 9_500_00, kind: "declared" })
    expect(retainedValueAt(watch("purchase"), "2026-10-03")).toEqual({ amount: 6_800_00, kind: "purchase" })
  })

  it("falls back in history when the retained value did not exist yet", () => {
    expect(retainedValueAt(watch("declared"), "2026-03-31")).toEqual({ amount: 9_000_00, kind: "estimated" })
    expect(retainedValueAt(watch("estimated"), "2025-12-31")).toEqual({ amount: 6_800_00, kind: "purchase" })
  })

  it("is null before the purchase", () => {
    expect(retainedValueAt(watch("estimated"), "2014-12-31")).toBeNull()
  })

  it("accepts undated values", () => {
    const art: AssetValues = { purchase: null, declared: { amount: 4_000_00, date: null }, estimateAt: () => null, retained: "estimated" }
    expect(retainedValueAt(art, "2020-01-01")).toEqual({ amount: 4_000_00, kind: "declared" })
  })
})

describe("latestOn", () => {
  it("finds the last entry on or before a day", () => {
    expect(latestOn(estimates, "2026-01-14")).toBeNull()
    expect(latestOn(estimates, "2026-06-01")?.amount).toBe(9_800_00)
    expect(latestOn(estimates, "2030-01-01")?.amount).toBe(10_200_00)
  })
})

describe("loans", () => {
  // 200 000 € over 20 years at 3 %: the textbook payment is 1 109,20 €.
  const terms = { principal: 200_000_00, annualRatePct: 3, months: 240, startDate: "2020-05-10" }

  it("computes the constant payment", () => {
    expect(Math.round(loanMonthlyPayment(terms))).toBe(1_109_20)
  })

  it("counts installments from the month after the start", () => {
    expect(loanPaymentsMade(terms, "2020-05-31")).toBe(0)
    expect(loanPaymentsMade(terms, "2020-06-09")).toBe(0)
    expect(loanPaymentsMade(terms, "2020-06-10")).toBe(1)
    expect(loanPaymentsMade(terms, "2045-01-01")).toBe(240)
  })

  it("amortizes the capital down to zero", () => {
    expect(loanBalance(terms, "2020-05-10")).toBe(200_000_00)
    const afterOne = loanBalance(terms, "2020-06-10")
    // First installment: 500 € interest, the rest pays down the capital.
    expect(afterOne).toBe(200_000_00 - (1_109_20 - 500_00) + 0)
    expect(loanBalance(terms, "2030-05-10")).toBeLessThan(120_000_00)
    expect(loanBalance(terms, "2040-05-10")).toBe(0)
    expect(loanBalance(terms, "2019-01-01")).toBe(0)
  })

  it("handles zero-rate loans and the end month", () => {
    const free = { principal: 12_000_00, annualRatePct: 0, months: 12, startDate: "2026-01-31" }
    expect(loanBalance(free, "2026-02-28")).toBe(11_000_00)
    expect(loanBalance(free, "2026-07-31")).toBe(6_000_00)
    expect(loanEndMonth(terms)).toBe("2040-05")
  })
})

describe("allocation", () => {
  it("nets buckets and shares only the positive ones", () => {
    const slices = allocation([
      { bucket: "real_estate", value: 298_400_00 },
      { bucket: "real_estate", value: -148_200_00 },
      { bucket: "investments", value: 42_300_00 },
      { bucket: "cash", value: 11_615_00 },
      { bucket: "vehicles", value: 0 },
    ])
    expect(slices.map((s) => s.bucket)).toEqual(["real_estate", "investments", "cash"])
    expect(slices[0]!.value).toBe(150_200_00)
    expect(slices.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1)
  })

  it("gives no share to a negative bucket", () => {
    const slices = allocation([
      { bucket: "real_estate", value: -10_00 },
      { bucket: "cash", value: 50_00 },
    ])
    expect(slices.find((s) => s.bucket === "real_estate")?.share).toBe(0)
    expect(slices.find((s) => s.bucket === "cash")?.share).toBe(1)
  })
})

describe("relativeChange", () => {
  it("is null from zero", () => {
    expect(relativeChange(0, 10)).toBeNull()
    expect(relativeChange(100, 104.2)).toBeCloseTo(0.042)
    expect(relativeChange(-100, -50)).toBeCloseTo(0.5)
  })
})

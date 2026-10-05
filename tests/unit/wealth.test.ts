import { describe, expect, it } from "vitest"
import {
  allocation,
  applyShare,
  assetTypeTotals,
  BUCKET_OF_TYPE,
  type AssetValues,
  formatShare,
  historyChange,
  isAutomaticSource,
  latestOn,
  applyLoanChanges,
  loanBalance,
  loanChangesProblem,
  loanEndMonth,
  loanMonthlyPayment,
  loanPaymentsMade,
  loanSchedule,
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

describe("shared ownership", () => {
  it("keeps the part owned, rounded to the cent", () => {
    expect(applyShare(450_000_00, 10_000)).toBe(450_000_00)
    expect(applyShare(450_000_00, 5_000)).toBe(225_000_00)
    expect(applyShare(100_01, 3_333)).toBe(33_33)
    expect(applyShare(-90_000_00, 5_000)).toBe(-45_000_00)
  })

  it("formats whole and fractional percentages", () => {
    expect(formatShare(5_000)).toBe("50\u00a0%")
    expect(formatShare(3_333)).toBe("33,33\u00a0%")
  })
})

describe("loans", () => {
  // 200 000 € over 20 years at 3 %: the textbook payment is 1 109,20 €.
  const terms = { principal: 200_000_00, annualRatePct: 3, months: 240, firstPaymentDate: "2020-06-10" }

  it("computes the constant payment", () => {
    expect(Math.round(loanMonthlyPayment(terms))).toBe(1_109_20)
  })

  it("counts installments from the first one", () => {
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

  it("repays a zero-rate loan in equal parts and ends a loan in the month of its last payment", () => {
    const free = { principal: 12_000_00, annualRatePct: 0, months: 12, firstPaymentDate: "2026-02-28" }
    expect(loanBalance(free, "2026-02-28")).toBe(11_000_00)
    expect(loanBalance(free, "2026-07-31")).toBe(6_000_00)
    expect(loanEndMonth(terms)).toBe("2040-05")
    expect(loanEndMonth({ ...free, firstPaymentDate: "2027-01-15", months: 1 })).toBe("2027-01")
    expect(loanEndMonth({ ...free, firstPaymentDate: "2026-02-15", months: 11 })).toBe("2026-12")
  })

  it("keeps the textbook schedule while no installment is changed", () => {
    const schedule = loanSchedule(terms)
    expect(schedule).toHaveLength(240)
    expect(schedule[0]).toMatchObject({ installment: 1, date: terms.firstPaymentDate })
    expect(new Set(schedule.slice(0, -1).map((row) => row.payment))).toEqual(new Set([1_109_20]))
    // Cents rounded every month stay within a euro of the exact amortization.
    const r = 0.0025
    const closedForm = 200_000_00 * (1 + r) ** 120 - (loanMonthlyPayment(terms) * ((1 + r) ** 120 - 1)) / r
    expect(schedule[119]).toMatchObject({ installment: 120, date: "2030-05-10" })
    expect(Math.abs(schedule[119]!.remaining - closedForm)).toBeLessThan(1_00)
    expect(schedule.at(-1)).toMatchObject({ date: "2040-05-10", remaining: 0 })
    expect(Math.abs(schedule.at(-1)!.payment - 1_109_20)).toBeLessThan(10_00)
  })

  it("rounds to the cent like the bank, matching its schedule to the cent", () => {
    // Action Logement, 40 000 € at 1,50 % over 300 months: rows of the lender's own schedule.
    const schedule = loanSchedule({ principal: 40_000_00, annualRatePct: 1.5, months: 300, firstPaymentDate: "2023-09-05" })
    expect(schedule[0]).toMatchObject({ payment: 159_97, interest: 50_00, capital: 109_97, remaining: 39_890_03 })
    expect(schedule[1]).toMatchObject({ interest: 49_86, remaining: 39_779_92 })
    expect(schedule[23]).toMatchObject({ date: "2025-08-05", interest: 46_79, remaining: 37_322_44 })
    expect(schedule[35]).toMatchObject({ date: "2026-08-05", interest: 45_09, remaining: 35_953_25 })
    expect(schedule[47]).toMatchObject({ date: "2027-08-05", interest: 43_35, remaining: 34_563_39 })
    expect(schedule).toHaveLength(300)
    expect(schedule.at(-1)).toMatchObject({ date: "2048-08-05", remaining: 0 })
  })

  it("defers six installments to their interest, then goes back to the contract's payment and ends six months later", () => {
    const deferral = { ...terms, overrides: [13, 14, 15, 16, 17, 18].map((installment) => ({ installment, payment: "interest_only" as const })) }
    const deferred = loanSchedule(deferral)
    expect(deferred.slice(0, 12)).toEqual(loanSchedule(terms).slice(0, 12))
    const before = deferred[11]!.remaining
    for (const row of deferred.slice(12, 18)) expect(row).toMatchObject({ capital: 0, payment: row.interest, remaining: before, override: "interest_only" })
    expect(deferred[18]).toMatchObject({ payment: 1_109_20, override: null })
    expect(deferred.at(-1)).toMatchObject({ installment: 246, remaining: 0 })
    expect(loanEndMonth(deferral)).toBe("2040-11")
    expect(loanBalance(deferral, "2040-08-10")).toBeGreaterThan(0)
  })

  it("adds unpaid interest to the capital, and ends the loan early on a payment that repays it", () => {
    const changed = loanSchedule({
      ...terms,
      overrides: [
        { installment: 1, payment: 0 },
        { installment: 2, payment: 300_000_00 },
      ],
    })
    expect(changed[0]).toMatchObject({ payment: 0, capital: -500_00, remaining: 200_500_00, override: "amount" })
    expect(changed).toHaveLength(2)
    expect(changed[1]).toMatchObject({ payment: 200_500_00 + 501_25, remaining: 0 })
    expect(loanBalance({ ...terms, overrides: [{ installment: 2, payment: 300_000_00 }] }, "2030-01-01")).toBe(0)
  })

  it("follows the new payments a bank sets after its deferrals, to the cent of its schedule", () => {
    // Crédit Mutuel, 450 000 € at 2,70 %: a year of interest only, a payment of 2 124,74 € on the
    // 288 months left, then a second deferral and 2 160,60 € from January 2027.
    const interestOnly = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({ installment: from + i, payment: "interest_only" as const }))
    const schedule = loanSchedule({
      principal: 450_000_00,
      annualRatePct: 2.7,
      months: 300,
      firstPaymentDate: "2023-04-05",
      overrides: [...interestOnly(1, 12), ...interestOnly(35, 45)],
      steps: [
        { installment: 13, payment: 2_124_74 },
        { installment: 46, payment: 2_160_60 },
      ],
    })
    expect(schedule[12]).toMatchObject({ date: "2024-04-05", payment: 2_124_74, interest: 1_012_50, capital: 1_112_24, override: "step" })
    expect(schedule[13]).toMatchObject({ payment: 2_124_74, remaining: 447_773_02, override: null })
    expect(schedule[33]).toMatchObject({ date: "2026-01-05", remaining: 424_943_87 })
    expect(schedule[44]).toMatchObject({ date: "2026-12-05", payment: 956_12, remaining: 424_943_87 })
    expect(schedule[45]).toMatchObject({ date: "2027-01-05", payment: 2_160_60, interest: 956_12, capital: 1_204_48, override: "step" })
    expect(schedule.at(-1)).toMatchObject({ date: "2048-08-05", payment: 2_158_91, interest: 4_85, remaining: 0 })
  })

  it("merges installment changes and refuses those outside the schedule", () => {
    const { overrides: merged, steps } = applyLoanChanges(
      {
        overrides: [
          { installment: 5, payment: 0 },
          { installment: 2, payment: "interest_only" },
        ],
        steps: [{ installment: 9, payment: 1_200_00 }],
      },
      [
        { installment: 5, payment: null },
        { installment: 1, payment: 100_00 },
        { installment: 9, payment: null },
        { installment: 2, payment: 1_500_00, onward: true },
      ],
    )
    expect(merged).toEqual([{ installment: 1, payment: 100_00 }])
    expect(steps).toEqual([{ installment: 2, payment: 1_500_00 }])
    expect(loanChangesProblem({ ...terms, overrides: merged, steps, insurance: 40_00 })).toBeNull()
    expect(loanChangesProblem({ ...terms, steps: [{ installment: 3, payment: 0 }] })).toMatch(/positif/)
    expect(loanChangesProblem({ ...terms, overrides: [{ installment: 480, payment: 0 }] })).toBeNull()
    expect(loanChangesProblem({ ...terms, overrides: [{ installment: 481, payment: 0 }] })).toMatch(/hors du tableau/)
    expect(loanChangesProblem({ ...terms, overrides: [{ installment: 3, payment: 0 }, { installment: 3, payment: 1 }] })).toMatch(/hors du tableau/)
    expect(loanChangesProblem({ ...terms, overrides: [{ installment: 3, payment: -1 }] })).toMatch(/positif/)
    expect(loanChangesProblem({ ...terms, insurance: 12.5 })).toMatch(/assurance/)
  })
})

describe("allocation", () => {
  it("sums buckets and shares only the positive ones, loans apart from real estate", () => {
    const slices = allocation([
      { bucket: "real_estate", value: 298_400_00 },
      { bucket: BUCKET_OF_TYPE.loan, value: -148_200_00 },
      { bucket: "investments", value: 42_300_00 },
      { bucket: "cash", value: 11_615_00 },
      { bucket: "vehicles", value: 0 },
    ])
    expect(slices.map((s) => [s.label, s.value])).toEqual([
      ["Immobilier", 298_400_00],
      ["Placements", 42_300_00],
      ["Liquidités", 11_615_00],
      ["Emprunts", -148_200_00],
    ])
    expect(slices.at(-1)!.fraction).toBe(0)
    expect(slices.reduce((a, s) => a + s.fraction, 0)).toBeCloseTo(1)
  })

  it("keeps crypto apart from the other investments", () => {
    expect(BUCKET_OF_TYPE.crypto).toBe("crypto")
    expect(BUCKET_OF_TYPE.investment).toBe("investments")
  })

  it("gives no share to a negative bucket", () => {
    const slices = allocation([
      { bucket: "real_estate", value: -10_00 },
      { bucket: "cash", value: 50_00 },
    ])
    expect(slices.find((s) => s.bucket === "real_estate")?.fraction).toBe(0)
    expect(slices.find((s) => s.bucket === "cash")?.fraction).toBe(1)
  })
})

describe("relativeChange", () => {
  it("has no ratio from zero and measures a change against the size of the starting value", () => {
    expect(relativeChange(0, 10)).toBeNull()
    expect(relativeChange(100, 104.2)).toBeCloseTo(0.042)
    expect(relativeChange(-100, -50)).toBeCloseTo(0.5)
  })
})

describe("assetTypeTotals", () => {
  const items = [
    { kind: "asset", type: "crypto", value: 7_000_00 },
    { kind: "asset", type: "loan", value: -150_000_00 },
    { kind: "account", type: "investment", value: 40_000_00 },
    { kind: "asset", type: "crypto", value: 1_500_00 },
    { kind: "asset", type: "real_estate", value: 250_000_00 },
  ] as const

  it("sums assets by type in a fixed order, leaving accounts and empty types out", () => {
    expect(assetTypeTotals(items, { includeAccounts: false })).toEqual([
      { type: "real_estate", total: 250_000_00, count: 1 },
      { type: "loan", total: -150_000_00, count: 1 },
      { type: "crypto", total: 8_500_00, count: 2 },
    ])
  })

  it("counts accounts under their type when asked", () => {
    expect(assetTypeTotals(items, { includeAccounts: true }).map((t) => t.type)).toEqual(["real_estate", "loan", "investment", "crypto"])
  })
})

describe("historyChange", () => {
  const months = ["2026-01", "2026-02", "2026-03"]

  it("compares now with the first month holding something", () => {
    expect(historyChange([0, 100_00, 150_00], months, 150_00)).toEqual({ amount: 50_00, ratio: 0.5, since: "2026-02" })
  })

  it("is null without an earlier month to compare with", () => {
    expect(historyChange([0, 0, 0], months, 0)).toBeNull()
    expect(historyChange([0, 0, 150_00], months, 150_00)).toBeNull()
  })
})

describe("isAutomaticSource", () => {
  it("is true for the sources priced from an outside feed only", () => {
    expect(["crypto", "stock", "real_estate"].map((kind) => isAutomaticSource({ kind }))).toEqual([true, true, true])
    expect(["manual", "loan"].map((kind) => isAutomaticSource({ kind }))).toEqual([false, false])
    expect(isAutomaticSource(null)).toBe(false)
  })
})

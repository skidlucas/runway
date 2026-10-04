import { describe, expect, it } from "vitest"
import {
  type CategoryInsightInput,
  computeFindings,
  computeView,
  type MonthTotals,
  projectedOverrunDay,
  projectMonthEnd,
  trailingAverage,
} from "~/domain/insights"

const plain = (s: string | undefined) => s?.replace(/[\u00a0\u202f]/g, " ")

const months = (values: Array<[string, number, number?]>): MonthTotals[] =>
  values.map(([month, total, toDate]) => ({ month, total, toDate: toDate ?? total, count: 1 }))

describe("trailingAverage", () => {
  it("averages the complete months before the index", () => {
    expect(trailingAverage([100, 200, 300, 999], 3, 3)).toBe(200)
    expect(trailingAverage([100, 200, 300], 2, 3)).toBeNull()
    expect(trailingAverage([100, 200], 1, 0)).toBeNull()
  })

  it("ignores the months before the first data point", () => {
    expect(trailingAverage([0, 0, 300, 100], 3, 3, 2)).toBe(300)
    expect(trailingAverage([0, 0, 300], 2, 2, 2)).toBeNull()
  })
})

describe("projectMonthEnd", () => {
  it("adds the usual rest of month to what is already spent", () => {
    // Rent paid on the 3rd: linear would say 85 000 / 10 * 31.
    const history = [
      { total: 100_000, toDate: 90_000 },
      { total: 110_000, toDate: 92_000 },
    ]
    expect(projectMonthEnd({ toDate: 91_000 }, history, "2026-10-10")).toBe(91_000 + 14_000)
  })

  it("falls back to a linear pace without history", () => {
    expect(projectMonthEnd({ toDate: 10_000 }, [], "2026-10-10")).toBe(31_000)
  })

  it("returns the actual total on the last day", () => {
    expect(projectMonthEnd({ toDate: 12_345 }, [{ total: 1, toDate: 0 }], "2026-10-31")).toBe(12_345)
  })
})

describe("projectedOverrunDay", () => {
  it("finds the day the budget will be crossed", () => {
    // 60 € spent by the 10th, 120 € projected: 60 € over 21 days, budget 90 € → 30 € later ≈ 11 days.
    expect(projectedOverrunDay(6000, 12_000, 9000, "2026-10-10")).toBe("2026-10-21")
    expect(projectedOverrunDay(6000, 8000, 9000, "2026-10-10")).toBeNull()
    expect(projectedOverrunDay(9500, 12_000, 9000, "2026-10-10")).toBe("2026-10-10")
  })
})

describe("computeView", () => {
  it("builds bars, trailing averages and a projection", () => {
    const totals = months([
      ["2026-06", 10_000],
      ["2026-07", 20_000],
      ["2026-08", 30_000],
      ["2026-09", 40_000, 20_000],
      ["2026-10", 15_000],
    ])
    const view = computeView({ totals, months: 2, rolling: 3, today: "2026-10-15", budget: 25_000 })
    expect(view.bars.map((b) => [b.month, b.value, b.average, b.current])).toEqual([
      ["2026-09", 40_000, 30_000, false],
      ["2026-10", 15_000, 30_000, true],
    ])
    expect(view.current).toBe(15_000)
    expect(view.average).toBe(30_000)
    // Rest of month from the last 3 complete months: (0 + 0 + 20 000) / 3.
    expect(view.projection).toBe(15_000 + 6667)
    expect(view.projectionAlert).toBe(false)
    expect(view.periodTotal).toBe(55_000)
    expect(view.periodAverage).toBe(40_000)
  })

  it("starts the rolling average where the data starts", () => {
    const totals: MonthTotals[] = [
      { month: "2026-07", total: 0, toDate: 0, count: 0 },
      { month: "2026-08", total: 0, toDate: 0, count: 0 },
      { month: "2026-09", total: 30_000, toDate: 10_000, count: 3 },
      { month: "2026-10", total: 5000, toDate: 5000, count: 1 },
    ]
    const view = computeView({ totals, months: 4, rolling: 3, today: "2026-10-10", budget: null })
    expect(view.bars.map((b) => b.average)).toEqual([null, null, 30_000, 30_000])
    expect(view.average).toBe(30_000)
    // Only September counts for the rest of the month, not the empty months before it.
    expect(view.projection).toBe(5000 + 20_000)
  })

  it("flags a projection above the budget", () => {
    const totals = months([
      ["2026-09", 10_000],
      ["2026-10", 20_000],
    ])
    const view = computeView({ totals, months: 2, rolling: 0, today: "2026-10-31", budget: 15_000 })
    expect(view.average).toBeNull()
    expect(view.projectionAlert).toBe(true)
  })
})

const category = (
  partial: Partial<CategoryInsightInput> & { history: CategoryInsightInput["history"] },
): CategoryInsightInput => ({ id: "c", name: "Restaurants", budgeted: 0, topPayee: null, ...partial })

const hist = (rows: Array<[string, number, number, number?]>) =>
  rows.map(([month, total, toDate, budgeted]) => ({ month, total, toDate, count: 1, budgeted: budgeted ?? 0 }))

describe("computeFindings", () => {
  it("warns when a category is projected above its budget and average", () => {
    const findings = computeFindings({
      today: "2026-10-10",
      categories: [
        category({
          budgeted: 12_000,
          history: hist([
            ["2026-04", 14_000, 4000],
            ["2026-05", 14_000, 4000],
            ["2026-06", 14_000, 4000],
            ["2026-07", 14_000, 4000],
            ["2026-08", 14_000, 4000],
            ["2026-09", 14_000, 4000],
            ["2026-10", 9000, 9000, 12_000],
          ]),
        }),
      ],
      topPayees: [],
      monthTotal: 0,
      newRecurring: [],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: "projection", tone: "negative", categoryId: "c" })
    // 9 000 + 10 000 of usual rest = 19 000 → +36 % vs a 140 € average.
    expect(plain(findings[0]?.text)).toBe("Restaurants : au rythme actuel, 190 € fin octobre, 36 % au-dessus de ta moyenne 6 mois.")
    expect(plain(findings[0]?.context)).toBe("Budget 120 € · dépassement probable le 17 oct.")
  })

  it("compares with the average without a budget, and says when the budget is already spent", () => {
    const sixMonths = (total: number, toDate: number) =>
      (["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"] as const).map((m): [string, number, number] => [m, total, toDate])
    const findingOf = (c: CategoryInsightInput) =>
      computeFindings({ today: "2026-10-10", categories: [c], topPayees: [], monthTotal: 0, newRecurring: [] })[0]

    const unbudgeted = findingOf(category({ history: hist([...sixMonths(10_000, 4000), ["2026-10", 9000, 9000]]) }))
    expect(plain(unbudgeted?.text)).toBe("Restaurants : au rythme actuel, 150 € fin octobre, 50 % au-dessus de ta moyenne 6 mois.")
    expect(plain(unbudgeted?.context)).toBe("Pas de budget · moyenne 6 mois 100 €")

    const spent = findingOf(category({ budgeted: 5000, history: hist([...sixMonths(20_000, 18_000), ["2026-10", 6000, 6000, 5000]]) }))
    expect(plain(spent?.text)).toBe("Restaurants : au rythme actuel, 80 € fin octobre, 60 % au-dessus du budget.")
    expect(plain(spent?.context)).toBe("Budget 50 € · déjà dépassé de 10 €")
  })

  it("skips pace-based findings in the first days of the month", () => {
    const overspending = category({
      budgeted: 12_000,
      history: hist([
        ["2026-07", 14_000, 4000],
        ["2026-08", 14_000, 4000],
        ["2026-09", 14_000, 4000],
        ["2026-10", 9000, 9000, 12_000],
      ]),
    })
    const input = { categories: [overspending], topPayees: [], monthTotal: 0, newRecurring: [] }
    expect(computeFindings({ ...input, today: "2026-10-05" })).toEqual([])
    expect(computeFindings({ ...input, today: "2026-10-08" }).map((f) => f.kind)).toEqual(["projection"])
  })

  it("reports a category clearly below the same date last month", () => {
    const [finding] = computeFindings({
      today: "2026-10-15",
      categories: [
        category({
          name: "Courses",
          topPayee: { name: "Monoprix", amount: 17_500 },
          history: hist([
            ["2026-09", 60_000, 32_600],
            ["2026-10", 28_700, 28_700],
          ]),
        }),
      ],
      topPayees: [],
      monthTotal: 0,
      newRecurring: [],
    })
    expect(finding?.kind).toBe("below_last_month")
    expect(plain(finding?.text)).toBe("Courses : 287 € dépensés, 12 % de moins qu'à la même date en septembre.")
    expect(plain(finding?.context)).toBe("Monoprix représente 61 % du poste")
  })

  it("reports consecutive overspent months and does not double-report projected categories", () => {
    const transport = category({
      id: "t",
      name: "Transport",
      budgeted: 9000,
      history: hist([
        ["2026-07", 10_000, 5000, 9000],
        ["2026-08", 11_000, 5000, 9000],
        ["2026-09", 9500, 5000, 9000],
        ["2026-10", 9800, 9800, 9000],
      ]),
    })
    const findings = computeFindings({ today: "2026-10-31", categories: [transport], topPayees: [], monthTotal: 0, newRecurring: [] })
    expect(findings.map((f) => f.kind)).toEqual(["overspent_streak"])
    expect(plain(findings[0]?.text)).toBe("Transport dépasse son budget pour le 4e mois consécutif.")
    expect(plain(findings[0]?.context)).toBe("Moyenne 3 mois : 101,67 € pour 90 € budgétés")
  })

  it("lists new recurring payments and top payees", () => {
    const findings = computeFindings({
      today: "2026-10-03",
      categories: [],
      topPayees: [
        { id: "p1", name: "Foncia", amount: 85_000, count: 1 },
        { id: "p2", name: "Monoprix", amount: 17_540, count: 4 },
      ],
      monthTotal: 170_000,
      newRecurring: [{ payeeId: "p3", payeeName: "Canal+", amount: -2599, lastDate: "2026-09-28", categoryName: null }],
    })
    expect(findings.map((f) => [f.kind, plain(f.text), plain(f.context)])).toEqual([
      ["new_recurring", "Nouveau prélèvement récurrent : Canal+ 25,99 €, le 28 sept.", "Non catégorisé · à affecter"],
      [
        "top_payees",
        "Top bénéficiaire du mois : Foncia (850 €), puis Monoprix (175,40 €).",
        "1 opération · 50 % des dépenses du mois",
      ],
    ])
  })
})

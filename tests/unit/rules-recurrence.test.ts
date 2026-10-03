import { describe, expect, it } from "vitest"
import { addMonths, daysInMonth, formatDayShort, formatMonthLong, monthRange, todayIn } from "~/domain/dates"
import { describeRecurrence, nextOnOrAfter, occurrence, occurrencesBetween } from "~/domain/recurrence"
import { detectRecurring, type HistoryTransaction } from "~/domain/recurring-detection"
import { applyRules, describeRule, type Rule } from "~/domain/rules"

describe("dates", () => {
  it("handles month arithmetic and labels", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12")
    expect(addMonths("2026-11", 3)).toBe("2027-02")
    expect(monthRange("2026-11", "2027-01")).toEqual(["2026-11", "2026-12", "2027-01"])
    expect(daysInMonth("2028-02")).toBe(29)
    expect(formatMonthLong("2026-10")).toBe("Octobre 2026")
    expect(formatDayShort("2026-10-02")).toBe("2 oct.")
    expect(todayIn("Europe/Paris", new Date("2026-10-01T22:30:00Z"))).toBe("2026-10-02")
  })
})

describe("rules", () => {
  const rules: Rule[] = [
    {
      id: "r1",
      conditionsOp: "and",
      conditions: [{ field: "imported_payee", op: "contains", value: "monop" }],
      actions: [
        { type: "set_category", categoryId: "courses" },
        { type: "set_payee", payeeId: "monoprix" },
      ],
      enabled: true,
    },
    {
      id: "r2",
      conditionsOp: "and",
      conditions: [
        { field: "payee", op: "is", value: "Netflix" },
        { field: "amount", op: "between", value: [1000, 2000] },
      ],
      actions: [{ type: "set_category", categoryId: "abonnements" }],
      enabled: true,
    },
    {
      id: "r3",
      conditionsOp: "or",
      conditions: [{ field: "payee", op: "matches", value: "^cb (picard|carrefour)" }],
      actions: [{ type: "set_category", categoryId: "courses" }],
      enabled: false,
    },
  ]
  const subject = { payeeName: null, importedPayee: null, notes: null, amount: -1349, accountId: "a" }

  it("matches case and accent insensitively", () => {
    const out = applyRules(rules, { ...subject, importedPayee: "CB MONOPRIX PARIS 12" })
    expect(out).toMatchObject({ categoryId: "courses", payeeId: "monoprix", matched: ["r1"] })
  })

  it("requires every condition with AND and compares absolute amounts", () => {
    expect(applyRules(rules, { ...subject, payeeName: "netflix" }).categoryId).toBe("abonnements")
    expect(applyRules(rules, { ...subject, payeeName: "Netflix", amount: -2500 }).categoryId).toBeUndefined()
  })

  it("ignores disabled rules", () => {
    expect(applyRules(rules, { ...subject, payeeName: "CB Picard" }).matched).toEqual([])
  })

  it("describes a rule in French", () => {
    const names = { category: (id: string) => ({ courses: "Courses" })[id], payee: () => "Monoprix", account: () => "" }
    expect(describeRule(rules[0]!, names)).toEqual({
      conditions: "Si le libellé bancaire contient « monop »",
      actions: "Catégoriser en Courses, renommer en Monoprix",
    })
  })
})

describe("recurrence", () => {
  const monthly = { startDate: "2026-01-31", endDate: null, recurrence: { unit: "month", interval: 1 } } as const

  it("clamps month ends without drifting", () => {
    expect(occurrence(monthly, 1)).toBe("2026-02-28")
    expect(occurrence(monthly, 2)).toBe("2026-03-31")
    expect(nextOnOrAfter(monthly, "2026-04-01")).toBe("2026-04-30")
  })

  it("lists occurrences in a window and respects the end date", () => {
    const weekly = { startDate: "2026-10-01", endDate: "2026-10-20", recurrence: { unit: "week", interval: 1 } } as const
    expect(occurrencesBetween(weekly, "2026-10-02", "2026-10-31")).toEqual(["2026-10-08", "2026-10-15"])
    expect(describeRecurrence({ unit: "month", interval: 3 })).toBe("Tous les trimestres")
  })
})

describe("recurring detection", () => {
  const tx = (date: string, amount: number, payeeId = "netflix"): HistoryTransaction => ({
    payeeId,
    payeeName: payeeId,
    date,
    amount,
    categoryId: "subs",
    accountId: "a",
  })

  it("detects a monthly subscription and predicts the next date", () => {
    const history = [tx("2026-06-28", -1349), tx("2026-07-28", -1349), tx("2026-08-28", -1349), tx("2026-09-28", -1399)]
    const [found] = detectRecurring(history, "2026-10-02")
    expect(found).toMatchObject({ payeeId: "netflix", recurrence: { unit: "month", interval: 1 }, nextDate: "2026-10-28" })
    expect(found?.amount).toBe(-1349)
  })

  it("ignores irregular payees and stopped series", () => {
    const groceries = [tx("2026-09-01", -4000, "monop"), tx("2026-09-03", -1200, "monop"), tx("2026-09-20", -8000, "monop")]
    const stopped = [tx("2026-01-05", -900, "gym"), tx("2026-02-05", -900, "gym"), tx("2026-03-05", -900, "gym")]
    expect(detectRecurring([...groceries, ...stopped], "2026-10-02")).toEqual([])
  })
})

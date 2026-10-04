import { describe, expect, it } from "vitest"
import { addMonths, daysInMonth, formatDayShort, formatMonthLong, monthRange, todayIn } from "~/domain/dates"
import { describeRecurrence, nextOnOrAfter, occurrence, occurrencesBetween } from "~/domain/recurrence"
import { detectRecurring, type HistoryTransaction } from "~/domain/recurring-detection"
import { applyRules, compileRules, describeRule, patternProblem, type Rule } from "~/domain/rules"

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

  it("reuses one compiled matcher across many transactions", () => {
    const match = compileRules([
      ...rules,
      {
        id: "r4",
        conditionsOp: "or",
        conditions: [
          { field: "notes", op: "starts_with", value: "  Café " },
          { field: "payee", op: "matches", value: "^sncf" },
        ],
        actions: [{ type: "set_notes", notes: "pause" }],
        enabled: true,
      },
    ])
    expect(match({ ...subject, notes: "CAFÉ  du coin" }).matched).toEqual(["r4"])
    expect(match({ ...subject, payeeName: "SNCF Connect" }).notes).toBe("pause")
    expect(match({ ...subject, importedPayee: "monoprix" }).matched).toEqual(["r1"])
    expect(match({ ...subject, payeeName: "Netflix" }).matched).toEqual(["r2"])
    expect(match(subject).matched).toEqual([])
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

  it("has a single occurrence for a one-off", () => {
    const once = { startDate: "2026-10-12", endDate: null, recurrence: { unit: "once", interval: 1 } } as const
    expect(nextOnOrAfter(once, "2026-10-01")).toBe("2026-10-12")
    expect(nextOnOrAfter(once, "2026-10-13")).toBeNull()
    expect(occurrencesBetween(once, "2026-10-01", "2026-12-31")).toEqual(["2026-10-12"])
    expect(describeRecurrence(once.recurrence)).toBe("Une seule fois")
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

describe("rule patterns", () => {
  it("accepts ordinary patterns", () => {
    expect(patternProblem("^cb (picard|carrefour)")).toBeNull()
    expect(patternProblem("prlv sepa .*edf")).toBeNull()
    expect(patternProblem("(\\d{2})/(\\d{2})")).toBeNull()
  })

  it("refuses broken, overly long or catastrophic patterns", () => {
    expect(patternProblem("(")).toMatch(/invalide/)
    expect(patternProblem("a".repeat(201))).toMatch(/trop longue/)
    expect(patternProblem("(a+)+$")).toMatch(/imbriquée/)
    expect(patternProblem("(\\w*x)*")).toMatch(/imbriquée/)
    expect(patternProblem("(a{1,})+")).toMatch(/imbriquée/)
  })

  it("never runs a refused pattern", () => {
    const rule: Rule = {
      id: "r",
      conditionsOp: "and",
      conditions: [{ field: "payee", op: "matches", value: "(a+)+$" }],
      actions: [{ type: "set_category", categoryId: "c" }],
      enabled: true,
    }
    const subject = { payeeName: `${"a".repeat(40)}!`, importedPayee: null, notes: null, amount: -100, accountId: "x" }
    expect(applyRules([rule], subject).categoryId).toBeUndefined()
  })
})

describe("rule matching edge cases", () => {
  const rule = (id: string, conditions: Rule["conditions"], actions: Rule["actions"] = [{ type: "set_category", categoryId: id }]): Rule => ({
    id,
    conditionsOp: "and",
    conditions,
    actions,
    enabled: true,
  })
  const subject = { payeeName: null, importedPayee: null, notes: null, amount: -1_349, accountId: "a" }

  it("lets the first matching rule win each field, and later rules fill the fields left", () => {
    const amazon = [{ field: "payee", op: "contains", value: "amazon" }] as const
    const out = applyRules(
      [
        rule("livres", amazon),
        rule("divers", amazon, [
          { type: "set_category", categoryId: "divers" },
          { type: "set_notes", notes: "Prime" },
        ]),
        rule("autre", amazon),
      ],
      { ...subject, payeeName: "Amazon EU" },
    )
    expect(out).toEqual({ categoryId: "livres", notes: "Prime", matched: ["livres", "divers"] })
  })

  it("never matches an invalid pattern, without failing the other rules", () => {
    const match = compileRules([rule("broken", [{ field: "payee", op: "matches", value: "(" }]), rule("ok", [{ field: "payee", op: "matches", value: "^sncf" }])])
    expect(match({ ...subject, payeeName: "SNCF (" }).matched).toEqual(["ok"])
  })

  it("reads the payee for the bank label of a line that has none", () => {
    const match = compileRules([rule("train", [{ field: "imported_payee", op: "contains", value: "sncf" }])])
    expect(match({ ...subject, payeeName: "SNCF Connect" }).categoryId).toBe("train")
    expect(match({ ...subject, payeeName: "SNCF Connect", importedPayee: "PRLV 12345" }).categoryId).toBeUndefined()
  })

  it("matches an account by its id only", () => {
    const match = compileRules([rule("is", [{ field: "account", op: "is", value: "a" }]), rule("contains", [{ field: "account", op: "contains", value: "a" }])])
    expect(match(subject).matched).toEqual(["is"])
    expect(match({ ...subject, accountId: "b" }).matched).toEqual([])
  })

  it("compares the absolute amount with the threshold as written", () => {
    const over = (value: number) => compileRules([rule("r", [{ field: "amount", op: "gt", value }])])
    const under = (value: number) => compileRules([rule("r", [{ field: "amount", op: "lt", value }])])
    expect(over(1_000)({ ...subject, amount: -1_349 }).categoryId).toBe("r")
    expect(over(1_000)({ ...subject, amount: 999 }).categoryId).toBeUndefined()
    expect(under(2_000)({ ...subject, amount: -1_349 }).categoryId).toBe("r")
    // A negative threshold is not flipped: "over -10 €" matches everything and "under -10 €" nothing.
    expect(over(-1_000)({ ...subject, amount: -1 }).categoryId).toBe("r")
    expect(under(-1_000)({ ...subject, amount: -1_349 }).categoryId).toBeUndefined()
    const exactly = compileRules([rule("r", [{ field: "amount", op: "is", value: -1_349 }])])
    expect([exactly({ ...subject, amount: 1_349 }).categoryId, exactly({ ...subject, amount: -1_349 }).categoryId]).toEqual(["r", "r"])
  })
})

describe("recurrence edge cases", () => {
  const timing = (startDate: string, unit: "day" | "week" | "month" | "year", interval = 1, endDate: string | null = null) => ({
    startDate,
    endDate,
    recurrence: { unit, interval },
  })

  it("steps by the interval", () => {
    expect(occurrencesBetween(timing("2026-10-01", "week", 2), "2026-10-02", "2026-11-30")).toEqual(["2026-10-15", "2026-10-29", "2026-11-12", "2026-11-26"])
    expect(occurrencesBetween(timing("2026-01-15", "month", 5), "2026-01-01", "2027-01-31")).toEqual(["2026-01-15", "2026-06-15", "2026-11-15"])
  })

  it("keeps a quarterly schedule on the 31st at each month end", () => {
    const quarterly = timing("2026-01-31", "month", 3)
    expect(occurrencesBetween(quarterly, "2026-01-01", "2027-02-01")).toEqual(["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31", "2027-01-31"])
    expect(nextOnOrAfter(quarterly, "2026-05-01")).toBe("2026-07-31")
  })

  it("comes back to the 29th of February in leap years", () => {
    expect(occurrencesBetween(timing("2024-02-29", "year"), "2024-01-01", "2028-12-31")).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ])
    expect(occurrence(timing("2028-01-31", "month"), 1)).toBe("2028-02-29")
  })

  it("has no occurrence when it ends before it starts", () => {
    const backwards = timing("2026-10-10", "month", 1, "2026-10-01")
    expect(nextOnOrAfter(backwards, "2026-09-01")).toBeNull()
    expect(nextOnOrAfter(backwards, "2026-11-01")).toBeNull()
    expect(occurrencesBetween(backwards, "2026-01-01", "2027-12-31")).toEqual([])
  })

  it("lists 400 occurrences at most unless told otherwise", () => {
    const daily = timing("2026-01-01", "day")
    const all = occurrencesBetween(daily, "2026-01-01", "2027-12-31")
    expect([all.length, all.at(-1)]).toEqual([400, "2027-02-04"])
    expect(occurrencesBetween(daily, "2026-01-01", "2027-12-31", 10)).toHaveLength(10)
  })
})

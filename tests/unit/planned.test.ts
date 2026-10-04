import { describe, expect, it } from "vitest"
import { type PlannedSchedule, plannedByCategory, plannedStatus, remainingOccurrences } from "~/domain/planned"
import type { Recurrence } from "~/domain/recurrence"

const schedule = (
  id: string,
  amount: number,
  recurrence: Recurrence,
  startDate: string,
  extra: Partial<Omit<PlannedSchedule, "timing">> & { endDate?: string } = {},
): PlannedSchedule => ({
  id,
  name: id,
  categoryId: "cat",
  amount,
  timing: { startDate, endDate: extra.endDate ?? null, recurrence },
  nextDate: startDate,
  active: true,
  lastBooked: null,
  ...extra,
})

const monthly = { unit: "month", interval: 1 } as const
const yearly = { unit: "year", interval: 1 } as const
const none = new Map<string, number>()

describe("plannedByCategory", () => {
  it("counts every occurrence of a frequent schedule in the month", () => {
    const planned = plannedByCategory([schedule("courses", -3000, { unit: "week", interval: 1 }, "2026-10-02")], "2026-10", none)
    // Fridays of October 2026: 2, 9, 16, 23, 30.
    expect(planned.get("cat")).toMatchObject({ amount: 15000, due: 15000, setAside: 0 })
    expect(planned.get("cat")?.lines[0]).toMatchObject({ kind: "due", date: "2026-10-02", count: 5, amount: 3000 })
  })

  it("keeps a monthly schedule already paid this month", () => {
    const paid = schedule("loyer", -85000, monthly, "2026-01-05", { nextDate: "2026-11-05" })
    expect(plannedByCategory([paid], "2026-10", none).get("cat")?.amount).toBe(85000)
  })

  it("smooths a yearly schedule until its date, net of the money already saved", () => {
    const insurance = schedule("assurance", -60000, yearly, "2027-06-15")
    expect(plannedByCategory([insurance], "2027-01", none).get("cat")).toMatchObject({ amount: 10000, setAside: 10000, saved: 0 })
    expect(plannedByCategory([insurance], "2027-01", new Map([["cat", 30000]])).get("cat")?.amount).toBe(5000)
    // Overspending carried in is not money set aside.
    expect(plannedByCategory([insurance], "2027-01", new Map([["cat", -2000]])).get("cat")?.amount).toBe(10000)
  })

  it("asks for the rest at once in the month of the due date, and nothing once it is covered", () => {
    const insurance = schedule("assurance", -60000, yearly, "2027-06-15")
    expect(plannedByCategory([insurance], "2027-06", new Map([["cat", 55000]])).get("cat")?.amount).toBe(5000)
    expect(plannedByCategory([insurance], "2027-06", new Map([["cat", 70000]])).get("cat")?.amount).toBe(0)
  })

  it("meets the nearest due date when several spaced-out schedules share a category", () => {
    const planned = plannedByCategory(
      [schedule("taxe", -120000, yearly, "2027-10-15"), schedule("entretien", -30000, yearly, "2027-02-10")],
      "2027-01",
      none,
    )
    // 300 € in 2 months (150 €/month) beats 1 500 € in 10 months (150 €/month): both hold at 150 €.
    expect(planned.get("cat")?.amount).toBe(15000)
    expect(planned.get("cat")?.lines.map((l) => l.scheduleId)).toEqual(["entretien", "taxe"])
  })

  it("rounds the amount set aside up to the euro", () => {
    const planned = plannedByCategory([schedule("assurance", -10000, yearly, "2027-03-01")], "2027-01", none)
    expect(planned.get("cat")?.amount).toBe(3400)
  })

  it("adds the dues of the month to the amount set aside", () => {
    const planned = plannedByCategory(
      [schedule("box", -3000, monthly, "2026-01-12"), schedule("assurance", -24000, yearly, "2027-03-01")],
      "2027-01",
      none,
    )
    expect(planned.get("cat")).toMatchObject({ due: 3000, setAside: 8000, amount: 11000 })
  })

  it("stops at the end date", () => {
    const loan = schedule("crédit", -21000, monthly, "2026-01-10", { endDate: "2026-09-10" })
    expect(plannedByCategory([loan], "2026-10", none).has("cat")).toBe(false)
  })

  it("leaves out income, uncategorized and stopped schedules", () => {
    const planned = plannedByCategory(
      [
        schedule("salaire", 300000, monthly, "2026-01-28"),
        schedule("virement", -50000, monthly, "2026-01-01", { categoryId: null }),
        schedule("ancien", -1000, monthly, "2026-01-01", { active: false }),
      ],
      "2026-10",
      none,
    )
    expect(planned.size).toBe(0)
  })

  describe("a yearly bill due on 2026-11-03", () => {
    const bill = (extra: Partial<PlannedSchedule>) => schedule("taxe", -60000, yearly, "2025-11-03", { nextDate: "2027-11-03", ...extra })

    it("paid early on 2026-10-30, counts in October and is not asked again in November", () => {
      const paidEarly = bill({ lastBooked: "2026-10-30" })
      expect(plannedByCategory([paidEarly], "2026-10", none).get("cat")).toMatchObject({
        thisMonth: 60000,
        lines: [{ date: "2026-10-30", monthsLeft: 1 }],
      })
      const november = plannedByCategory([paidEarly], "2026-11", none).get("cat")
      expect(november).toMatchObject({ thisMonth: 0, lines: [{ date: "2027-11-03", monthsLeft: 13 }] })
      expect(november?.amount).toBe(4700)
    })

    it("paid on time, stays due in November", () => {
      expect(plannedByCategory([bill({ lastBooked: "2026-11-03" })], "2026-11", none).get("cat")).toMatchObject({
        amount: 60000,
        thisMonth: 60000,
        lines: [{ date: "2026-11-03", monthsLeft: 1 }],
      })
    })

    it("skipped, is not asked in November", () => {
      expect(plannedByCategory([bill({ lastBooked: "2025-11-03" })], "2026-11", none).get("cat")).toMatchObject({
        thisMonth: 0,
        lines: [{ date: "2027-11-03" }],
      })
    })

    it("not paid yet, is due in November", () => {
      expect(plannedByCategory([bill({ nextDate: "2026-11-03", lastBooked: "2025-11-03" })], "2026-11", none).get("cat")).toMatchObject({
        thisMonth: 60000,
        lines: [{ date: "2026-11-03", monthsLeft: 1 }],
      })
    })
  })
})

describe("plannedStatus", () => {
  const toll = schedule("péage", -8000, monthly, "2026-01-17")

  it("counts the money carried in against this month's dues", () => {
    const planned = plannedByCategory([toll], "2026-10", new Map([["cat", 3517]])).get("cat")!
    expect(planned).toMatchObject({ amount: 8000, thisMonth: 8000, toBudget: 4483 })
    expect(plannedStatus(planned, 5000)).toBe("covered")
    expect(plannedStatus(planned, 4000)).toBe("short")
  })

  it("is upcoming once this month is paid but a later schedule is behind", () => {
    const insurance = schedule("assurance", -60000, yearly, "2027-06-15")
    const planned = plannedByCategory([toll, insurance], "2027-01", new Map([["cat", 38000]])).get("cat")!
    // The 380 € carried in pay the 80 € toll first; the 300 € left cut the insurance to 50 €/month.
    expect(planned).toMatchObject({ amount: 13000, setAside: 5000, thisMonth: 8000, toBudget: 5000 })
    expect(plannedStatus(planned, 0)).toBe("upcoming")
    expect(plannedStatus(planned, 5000)).toBe("covered")
  })

  it("is short when a spaced-out schedule falls this month and the envelope cannot pay it", () => {
    const planned = plannedByCategory([schedule("assurance", -60050, yearly, "2027-06-15")], "2027-06", new Map([["cat", 50000]])).get("cat")!
    expect(planned).toMatchObject({ thisMonth: 60050, toBudget: 10050 })
    expect(plannedStatus(planned, 10000)).toBe("short")
    expect(plannedStatus(planned, 10050)).toBe("covered")
  })
})

describe("remainingOccurrences", () => {
  it("counts the occurrences left until the end date, an overdue one included", () => {
    const timing = { startDate: "2026-01-10", endDate: "2027-12-10", recurrence: monthly }
    expect(remainingOccurrences(timing, "2026-09-10", -21000)).toEqual({ count: 16, total: 336000, until: "2027-12-10" })
  })

  it("is null without an end date or once nothing is left", () => {
    expect(remainingOccurrences({ startDate: "2026-01-10", endDate: null, recurrence: monthly }, "2026-10-10", -100)).toBeNull()
    expect(remainingOccurrences({ startDate: "2026-01-10", endDate: "2026-09-30", recurrence: monthly }, "2026-10-10", -100)).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import { addDays, addMonths, diffDays, formatDayInput, isDay, isMonth, lastDay, monthRange, parseDayInput, todayIn, weekday } from "~/domain/dates"

describe("calendar edges", () => {
  it("knows the last day of every kind of month, leap years included", () => {
    expect(["2026-01", "2026-02", "2026-04", "2026-12"].map(lastDay)).toEqual(["2026-01-31", "2026-02-28", "2026-04-30", "2026-12-31"])
    expect(["2024-02", "2028-02", "2000-02", "2100-02"].map(lastDay)).toEqual(["2024-02-29", "2028-02-29", "2000-02-29", "2100-02-28"])
  })

  it("moves months across years in both directions", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01")
    expect(addMonths("2026-01", -12)).toBe("2025-01")
    expect(addMonths("2026-01", -13)).toBe("2024-12")
    expect(addMonths("2026-03", -26)).toBe("2024-01")
    expect(addMonths("2026-12", 25)).toBe("2029-01")
    expect(addMonths("2026-05", 0)).toBe("2026-05")
    expect(monthRange("2027-01", "2026-12")).toEqual([])
  })

  it("moves days across month ends, leap days and daylight saving changes", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29")
    expect(addDays("2028-02-28", 2)).toBe("2028-03-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-01-31", 31)).toBe("2026-03-03")
    expect(diffDays("2028-01-01", "2029-01-01")).toBe(366)
    expect(diffDays("2026-03-28", "2026-03-30")).toBe(2)
    expect(diffDays("2026-10-24", "2026-10-26")).toBe(2)
    expect(diffDays("2026-10-04", "2026-10-01")).toBe(-3)
    expect(weekday("2026-10-04")).toBe(6)
    expect(weekday("2026-10-05")).toBe(0)
  })

  it("accepts only days and months that exist, within the supported years", () => {
    expect(isDay("2028-02-29")).toBe(true)
    expect(isDay("2026-02-29")).toBe(false)
    expect(isDay("2100-02-29")).toBe(false)
    expect(isDay("2026-04-31")).toBe(false)
    expect(isDay("2026-13-01")).toBe(false)
    expect(isDay("2026-1-01")).toBe(false)
    expect(isMonth("1899-12")).toBe(false)
    expect(isMonth("2200-01")).toBe(false)
    expect(isMonth("2026-00")).toBe(false)
  })

  it("takes today in the user's time zone, not UTC", () => {
    expect(todayIn("Europe/Paris", new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01")
    expect(todayIn("Europe/Paris", new Date("2026-03-29T00:30:00Z"))).toBe("2026-03-29")
    expect(todayIn("America/New_York", new Date("2026-10-04T03:00:00Z"))).toBe("2026-10-03")
  })
})

describe("typed dates", () => {
  const ref = "2026-10-03"

  it("formats a day the way it is typed", () => {
    expect(formatDayInput("2026-03-07")).toBe("07/03/2026")
  })

  it("reads full dates in French order or ISO", () => {
    expect(parseDayInput("7/3/2026", ref)).toBe("2026-03-07")
    expect(parseDayInput("07.03.26", ref)).toBe("2026-03-07")
    expect(parseDayInput(" 2026-03-07 ", ref)).toBe("2026-03-07")
  })

  it("fills the month and year left out from the reference day", () => {
    expect(parseDayInput("15", ref)).toBe("2026-10-15")
    expect(parseDayInput("15/2", ref)).toBe("2026-02-15")
  })

  it("rejects days that do not exist and stray text", () => {
    expect(parseDayInput("31/2/2026", ref)).toBeNull()
    expect(parseDayInput("", ref)).toBeNull()
    expect(parseDayInput("12/3/202", ref)).toBeNull()
    expect(parseDayInput("demain", ref)).toBeNull()
    expect(parseDayInput("1/2/3/4", ref)).toBeNull()
  })
})

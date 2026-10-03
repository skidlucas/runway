import { describe, expect, it } from "vitest"
import { formatDayInput, parseDayInput } from "~/domain/dates"

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

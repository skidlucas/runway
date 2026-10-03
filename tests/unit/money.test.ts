import { describe, expect, it } from "vitest"
import { formatCompact, formatMoney, formatPercent, parseAmount } from "~/domain/money"

const nbsp = (s: string) => s.replace(/ /g, " ").replace(/ €/g, " €")

describe("formatMoney", () => {
  it("formats fr-FR with typographic minus", () => {
    expect(formatMoney(284000)).toBe(nbsp("2 840,00 €"))
    expect(formatMoney(-31280)).toBe(nbsp("−312,80 €"))
    expect(formatMoney(0)).toBe(nbsp("0,00 €"))
    expect(formatMoney(4218, { sign: "always" })).toBe(nbsp("+42,18 €"))
    expect(formatMoney(23781500, { decimals: 0 })).toBe(nbsp("237 815 €"))
  })

  it("does not print a minus sign for amounts that round to zero", () => {
    expect(formatMoney(-40, { decimals: 0 })).toBe(nbsp("0 €"))
  })

  it("formats compact and percent values", () => {
    expect(formatCompact(123456)).toBe("1,2\u00a0k€")
    expect(formatPercent(0.042, { sign: true })).toBe("+4,2\u00a0%")
    expect(formatPercent(-0.175)).toBe("−17,5\u00a0%")
  })
})

describe("parseAmount", () => {
  it.each([
    ["42,18", 4218],
    ["42.18", 4218],
    ["1 234,5", 123450],
    ["1.234,56", 123456],
    ["1,234.56", 123456],
    ["-12", -1200],
    ["−12,5", -1250],
    ["850 €", 85000],
    ["=120+30", 15000],
    ["=(45*2)/3", 3000],
    ["=10,5+0,5", 1100],
    ["=-20+5", -1500],
  ])("parses %s", (input, expected) => {
    expect(parseAmount(input)).toBe(expected)
  })

  it.each(["", "abc", "12abc", "=1/0", "=(1+2", "1..2"])("rejects %s", (input) => {
    expect(parseAmount(input)).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import { amountInput, formatCompact, formatMoney, formatPercent, parseAmount } from "~/domain/money"

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

  it.each(["", "abc", "12abc", "=1/0", "=(1+2", "1..2", "1.234.567", "1,234,567"])("rejects %s", (input) => {
    expect(parseAmount(input)).toBeNull()
  })

  it("reads a lone separator as the decimal one, even before three digits, and rounds to the cent", () => {
    expect(parseAmount("1.234")).toBe(123)
    expect(parseAmount("1,234")).toBe(123)
    expect(parseAmount("1.235")).toBe(124)
    expect(parseAmount("1 234 567,89")).toBe(123_456_789)
    expect(parseAmount("1.234.567,89")).toBe(123_456_789)
    expect(parseAmount("+12")).toBe(1200)
  })

  it("reads back every amount it formats, with or without currency, sign or grouping", () => {
    let seed = 42
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    const samples = [0, 1, -1, 99, -100, 100_000, -123_456_789, 999_999_999_99]
    for (let i = 0; i < 500; i++) samples.push(Math.round((random() - 0.5) * 10 ** Math.ceil(random() * 11)) || 0)
    for (const cents of samples) {
      for (const text of [
        formatMoney(cents),
        formatMoney(cents, { currency: false }),
        formatMoney(cents, { sign: "always" }),
        amountInput(cents),
      ]) {
        expect(parseAmount(text), text).toBe(cents)
      }
    }
  })
})

// Amounts are integer cents. Formatting follows fr-FR with a typographic minus sign.

const MINUS = "−"

const formatters = new Map<string, Intl.NumberFormat>()
const formatter = (decimals: number) => {
  const key = String(decimals)
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    formatters.set(key, f)
  }
  return f
}

export type FormatOptions = {
  /** "always" prefixes positive amounts with "+". */
  sign?: "auto" | "always"
  decimals?: 0 | 2
  currency?: boolean
}

export const formatMoney = (cents: number, options: FormatOptions = {}): string => {
  const { sign = "auto", decimals = 2, currency = true } = options
  const abs = Math.abs(cents) / 100
  const rounded = decimals === 0 ? Math.round(abs) : abs
  const body = formatter(decimals).format(rounded) + (currency ? " €" : "")
  const isZero = decimals === 0 ? Math.round(abs) === 0 : cents === 0
  if (cents < 0 && !isZero) return MINUS + body
  if (sign === "always" && !isZero) return "+" + body
  return body
}

/** Compact form for dense charts: "1,2 k€". */
export const formatCompact = (cents: number): string => {
  const euros = cents / 100
  const abs = Math.abs(euros)
  const prefix = euros < 0 ? MINUS : ""
  if (abs >= 1_000_000) return `${prefix}${formatter(1).format(abs / 1_000_000)} M€`
  if (abs >= 10_000) return `${prefix}${formatter(0).format(abs / 1000)} k€`
  if (abs >= 1000) return `${prefix}${formatter(1).format(abs / 1000)} k€`
  return `${prefix}${formatter(0).format(abs)} €`
}

export const formatPercent = (ratio: number, options: { sign?: boolean; decimals?: number } = {}): string => {
  const { sign = false, decimals = 1 } = options
  const value = formatter(decimals).format(Math.abs(ratio) * 100) + " %"
  if (ratio < 0) return MINUS + value
  if (sign && ratio > 0) return "+" + value
  return value
}

const smallPrice = new Intl.NumberFormat("fr-FR", { maximumSignificantDigits: 3 })

/** A unit price in euros: to the cent from 1 €, otherwise 3 significant digits (coins worth a fraction of a cent). */
export const formatUnitPrice = (euros: number): string =>
  euros >= 1 ? formatMoney(Math.round(euros * 100)) : `${smallPrice.format(euros)} €`

/** Cents as typed in an amount field: "1234,50", no grouping, no currency. */
export const amountInput = (cents: number): string => (cents / 100).toFixed(2).replace(".", ",")

// --- Parsing ---------------------------------------------------------------

/**
 * Parses what a user types in an amount field: "42,18", "1 234.5", "-12", "−12",
 * or a formula starting with "=" ("=120+30", "=(45*2)/3").
 * Returns cents, or null when the input is not a valid amount.
 */
export const parseAmount = (raw: string): number | null => {
  const input = raw.trim()
  if (input === "") return null
  const isFormula = input.startsWith("=")
  const cleaned = (isFormula ? input.slice(1) : input)
    .replace(/[\s  €]/g, "")
    .replace(/[−–]/g, "-")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
  const expr = isFormula ? cleaned.replace(/,/g, ".") : normalizeSeparators(cleaned)
  if (!isFormula && !/^[+-]?\d*(\.\d*)?$/.test(expr)) return null
  const value = evaluate(expr)
  if (value === null || !Number.isFinite(value)) return null
  return Math.round(value * 100)
}

// With both "." and "," present, the last one is the decimal separator ("1.234,56", "1,234.56").
const normalizeSeparators = (text: string) => {
  const lastDot = text.lastIndexOf(".")
  const lastComma = text.lastIndexOf(",")
  if (lastDot >= 0 && lastComma >= 0) {
    const thousands = lastDot > lastComma ? /,/g : /\./g
    return text.replace(thousands, "").replace(",", ".")
  }
  return text.replace(",", ".")
}

// Recursive-descent evaluator for + - * / and parentheses. No eval().
const evaluate = (expr: string): number | null => {
  let pos = 0
  const peek = () => expr[pos]
  const parseNumber = (): number | null => {
    const match = /^\d*\.?\d+|^\d+\.?/.exec(expr.slice(pos))
    if (!match) return null
    pos += match[0].length
    return Number(match[0])
  }
  const parseFactor = (): number | null => {
    const c = peek()
    if (c === "+") {
      pos++
      return parseFactor()
    }
    if (c === "-") {
      pos++
      const v = parseFactor()
      return v === null ? null : -v
    }
    if (c === "(") {
      pos++
      const v = parseExpr()
      if (peek() !== ")") return null
      pos++
      return v
    }
    return parseNumber()
  }
  const parseTerm = (): number | null => {
    let left = parseFactor()
    while (left !== null && (peek() === "*" || peek() === "/")) {
      const op = expr[pos++]
      const right = parseFactor()
      if (right === null) return null
      if (op === "/" && right === 0) return null
      left = op === "*" ? left * right : left / right
    }
    return left
  }
  const parseExpr = (): number | null => {
    let left = parseTerm()
    while (left !== null && (peek() === "+" || peek() === "-")) {
      const op = expr[pos++]
      const right = parseTerm()
      if (right === null) return null
      left = op === "+" ? left + right : left - right
    }
    return left
  }
  const result = parseExpr()
  return pos === expr.length ? result : null
}

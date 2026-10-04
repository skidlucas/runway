import Papa from "papaparse"
import { isDay } from "~/domain/dates"
import { parseAmount } from "~/domain/money"

// Bank statement files (CSV, OFX, QIF) become a flat list of transactions for one account.

type BankTransaction = {
  date: string
  amount: number
  payee: string
  notes: string | null
  importedId: string | null
}

export type CsvMapping = {
  date: number
  payee: number
  notes: number | null
  /** Either one signed amount column, or separate debit / credit columns. */
  amount: number | null
  debit: number | null
  credit: number | null
  dateFormat: "dmy" | "ymd" | "mdy"
  hasHeader: boolean
}

/** `errors` counts the entries that could not be read and are left out. */
export type ParsedBankFile = { transactions: BankTransaction[]; errors: number }

export type CsvPreview = { rows: string[][]; mapping: CsvMapping; headers: string[] }

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()

export const parseCsvText = (text: string): string[][] => {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" })
  return result.data.filter((r) => r.some((c) => c.trim() !== ""))
}

const DATE_RE = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/

/** Two-digit years up to next year are this century's; later ones are the previous century's (98 → 1998). */
const fullYear = (y: number) => {
  const pivot = (new Date().getFullYear() % 100) + 1
  return y > pivot ? 1900 + y : 2000 + y
}

const parseDate = (raw: string, format: CsvMapping["dateFormat"]): string | null => {
  const m = DATE_RE.exec(raw.trim())
  if (!m) return null
  let [, a, b, c] = m as unknown as [string, string, string, string]
  let y: number, mo: number, d: number
  if (a.length === 4) {
    y = Number(a)
    mo = Number(b)
    d = Number(c)
  } else if (format === "mdy") {
    mo = Number(a)
    d = Number(b)
    y = Number(c)
  } else {
    d = Number(a)
    mo = Number(b)
    y = Number(c)
  }
  if (y < 100) y = fullYear(y)
  const day = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  return isDay(day) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? day : null
}

const findColumn = (headers: string[], patterns: RegExp[]) => {
  const i = headers.findIndex((h) => patterns.some((p) => p.test(norm(h))))
  return i >= 0 ? i : null
}

/** Guesses which column is which from the header row and the values. */
export const guessCsvMapping = (rows: string[][]): CsvPreview => {
  const first = rows[0] ?? []
  const hasHeader = first.some((c) => /[a-z]/i.test(c) && parseDate(c, "dmy") === null && parseAmount(c) === null)
  const headers = hasHeader ? first : first.map((_, i) => `Colonne ${i + 1}`)
  const body = hasHeader ? rows.slice(1) : rows
  const sample = body.slice(0, 50)

  let date = findColumn(headers, [/date/, /^jour/])
  if (date === null) date = headers.findIndex((_, i) => sample.every((r) => parseDate(r[i] ?? "", "dmy") !== null))
  let amount = findColumn(headers, [/montant/, /amount/, /^somme/, /valeur/])
  const debit = findColumn(headers, [/debit/, /sortie/, /withdrawal/])
  const credit = findColumn(headers, [/credit/, /entree/, /deposit/])
  let payee = findColumn(headers, [/libelle/, /beneficiaire/, /payee/, /description/, /tiers/, /^nom/, /label/, /intitule/])
  const notes = findColumn(headers, [/note/, /memo/, /commentaire/, /detail/])
  if (amount === null && (debit === null || credit === null)) {
    amount = headers.findIndex((_, i) => i !== date && sample.length > 0 && sample.every((r) => parseAmount(r[i] ?? "") !== null))
    if (amount < 0) amount = null
  }
  if (payee === null) {
    payee = headers.findIndex((_, i) => i !== date && i !== amount && sample.some((r) => /[a-z]{3}/i.test(r[i] ?? "")))
  }
  // Day/month order: a first number above 12 settles it.
  const dateValues = sample.map((r) => r[Math.max(date ?? 0, 0)] ?? "")
  const mdy = dateValues.some((v) => {
    const m = DATE_RE.exec(v)
    return m && m[1]!.length <= 2 && Number(m[2]) > 12
  })
  return {
    rows,
    headers,
    mapping: {
      date: Math.max(date ?? 0, 0),
      payee: Math.max(payee ?? 1, 0),
      notes: notes !== null && notes !== payee ? notes : null,
      amount: amount !== null && amount >= 0 ? amount : null,
      debit: amount === null ? debit : null,
      credit: amount === null ? credit : null,
      dateFormat: mdy ? "mdy" : "dmy",
      hasHeader,
    },
  }
}

export const applyCsvMapping = (rows: string[][], mapping: CsvMapping): ParsedBankFile => {
  const body = mapping.hasHeader ? rows.slice(1) : rows
  const transactions: BankTransaction[] = []
  let errors = 0
  for (const r of body) {
    const date = parseDate(r[mapping.date] ?? "", mapping.dateFormat)
    let amount: number | null = null
    if (mapping.amount !== null) amount = parseAmount(r[mapping.amount] ?? "")
    else if (mapping.debit !== null || mapping.credit !== null) {
      const d = mapping.debit !== null ? parseAmount(r[mapping.debit] ?? "") : null
      const c = mapping.credit !== null ? parseAmount(r[mapping.credit] ?? "") : null
      if (d !== null || c !== null) amount = (c !== null ? Math.abs(c) : 0) - (d !== null ? Math.abs(d) : 0)
    }
    if (!date || amount === null) {
      errors++
      continue
    }
    transactions.push({
      date,
      amount,
      payee: (r[mapping.payee] ?? "").trim(),
      notes: mapping.notes !== null ? (r[mapping.notes] ?? "").trim() || null : null,
      importedId: null,
    })
  }
  return { transactions, errors }
}

// --- OFX ---------------------------------------------------------------------------

const ofxField = (block: string, tag: string) => {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block)
  return m ? m[1]!.trim() : null
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"')

/** Handles both SGML (OFX 1.x, no closing tags) and XML (OFX 2.x) statements. */
export const parseOfx = (text: string): ParsedBankFile => {
  const blocks = text.split(/<STMTTRN>/i).slice(1)
  const out: BankTransaction[] = []
  let errors = 0
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>/i)[0] ?? raw
    const posted = ofxField(block, "DTPOSTED")
    const amount = parseAmount(ofxField(block, "TRNAMT") ?? "")
    const date = posted ? `${posted.slice(0, 4)}-${posted.slice(4, 6)}-${posted.slice(6, 8)}` : ""
    if (amount === null || !isDay(date)) {
      errors++
      continue
    }
    const name = ofxField(block, "NAME") ?? ofxField(block, "PAYEE") ?? ""
    const memo = ofxField(block, "MEMO")
    out.push({
      date,
      amount,
      payee: decodeEntities(name || memo || ""),
      notes: memo && memo !== name ? decodeEntities(memo) : null,
      importedId: ofxField(block, "FITID"),
    })
  }
  return { transactions: out, errors }
}

// --- QIF ---------------------------------------------------------------------------

export const parseQif = (text: string): ParsedBankFile => {
  const records = text.split(/^\^\s*$/m)
  const out: BankTransaction[] = []
  let errors = 0
  const raw: Array<{ d: string; t: string; p: string; m: string | null }> = []
  for (const record of records) {
    let d = ""
    let t = ""
    let p = ""
    let m: string | null = null
    for (const line of record.split(/\r?\n/)) {
      const code = line.charAt(0)
      const value = line.slice(1).trim()
      if (code === "D") d = value
      else if (code === "T" || code === "U") t = value
      else if (code === "P") p = value
      else if (code === "M") m = value
    }
    // Quicken writes dates like "1/ 5'98": an apostrophe before the year and space-padded parts.
    if (d && t) raw.push({ d: d.replace(/'/g, "/").replace(/\s+/g, ""), t, p, m })
    else if (d || t) errors++
  }
  const mdy = raw.some((r) => {
    const m = /^(\d{1,2})[/.-](\d{1,2})/.exec(r.d)
    return m && Number(m[2]) > 12
  })
  for (const r of raw) {
    const date = parseDate(r.d, mdy ? "mdy" : "dmy")
    const amount = parseAmount(r.t.replace(/,(?=\d{3}\b)/g, ""))
    if (!date || amount === null) {
      errors++
      continue
    }
    out.push({ date, amount, payee: r.p || r.m || "", notes: r.p && r.m ? r.m : null, importedId: null })
  }
  return { transactions: out, errors }
}

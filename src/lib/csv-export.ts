import { amountInput } from "~/domain/money"
import type { ExportData } from "./export"

const quote = (s: string) => (/[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

// Spreadsheets run a cell starting with one of these as a formula: a payee or note such as
// "=HYPERLINK(...)" would execute when the export is opened. The leading quote keeps it text.
const FORMULA_START = /^[=+\-@\t\r]/

/** A text cell of the `;`-separated export. */
export const csvText = (value: string | null) => {
  const s = value ?? ""
  return quote(FORMULA_START.test(s) ? `'${s}` : s)
}

/** A numeric cell, written as is so that negative amounts stay numbers. */
export const csvNumber = (value: string) => quote(value)

/** One line per operation, split lines in place of their parent; the BOM makes Excel read it as UTF-8. */
export const operationsCsv = ({ meta, transactions }: ExportData): string => {
  const account = new Map(meta.accounts.map((a) => [a.id, a.name]))
  const payee = new Map(meta.payees.map((p) => [p.id, p.transferAccountId ? `Virement ${account.get(p.transferAccountId) ?? ""}` : p.name]))
  const category = new Map(meta.categories.map((c) => [c.id, c.name]))
  const lines = ["Date;Compte;Bénéficiaire;Catégorie;Montant;Note;Pointée"]
  for (const t of transactions) {
    if (t.isParent) continue
    lines.push(
      [
        csvText(t.date),
        csvText(account.get(t.accountId) ?? ""),
        csvText(t.payeeId ? (payee.get(t.payeeId) ?? "") : ""),
        csvText(t.categoryId ? (category.get(t.categoryId) ?? "") : ""),
        csvNumber(amountInput(t.amount)),
        csvText(t.notes),
        csvText(t.cleared ? "oui" : "non"),
      ].join(";"),
    )
  }
  return "﻿" + lines.join("\n")
}

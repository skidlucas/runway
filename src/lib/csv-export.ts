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

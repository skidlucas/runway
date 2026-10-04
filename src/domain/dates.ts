import { capitalize } from "./text"

// Calendar helpers on plain ISO strings. Days are `YYYY-MM-DD`, months are `YYYY-MM`.
// Everything is computed in UTC on purpose: the strings already carry the user's local date.

export type Day = string
export type Month = string

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

// Years are bounded: a budget walks every month between its first and last transaction, so a
// typo like 0201 or 9999 would mean thousands of months computed on each page.
const MIN_YEAR = 1900
const MAX_YEAR = 2199

export const isMonth = (value: string): boolean => {
  if (!/^\d{4}-\d{2}$/.test(value)) return false
  const y = Number(value.slice(0, 4))
  const m = Number(value.slice(5, 7))
  return y >= MIN_YEAR && y <= MAX_YEAR && m >= 1 && m <= 12
}

export const isDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isMonth(value.slice(0, 7))) return false
  const d = Number(value.slice(8, 10))
  return d >= 1 && d <= daysInMonth(value.slice(0, 7))
}

export const monthOf = (day: Day): Month => day.slice(0, 7)

export const parseDay = (day: Day): { y: number; m: number; d: number } => ({
  y: Number(day.slice(0, 4)),
  m: Number(day.slice(5, 7)),
  d: Number(day.slice(8, 10)),
})

export const makeDay = (y: number, m: number, d: number): Day => {
  const date = new Date(Date.UTC(y, m - 1, d))
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

export const addMonths = (month: Month, delta: number): Month => {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7)) - 1 + delta
  const year = y + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return `${pad(year, 4)}-${pad(mm + 1)}`
}

/** Inclusive list of months from `from` to `to`. */
export const monthRange = (from: Month, to: Month): Month[] => {
  const out: Month[] = []
  // Bounded by the valid years, so a malformed month can never loop forever.
  for (let m = from; m <= to && out.length <= (MAX_YEAR - MIN_YEAR + 1) * 12; m = addMonths(m, 1)) out.push(m)
  return out
}

export const daysInMonth = (month: Month): number => {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export const firstDay = (month: Month): Day => `${month}-01`
export const lastDay = (month: Month): Day => `${month}-${pad(daysInMonth(month))}`

export const addDays = (day: Day, delta: number): Day => {
  const { y, m, d } = parseDay(day)
  return makeDay(y, m, d + delta)
}

export const diffDays = (from: Day, to: Day): number => {
  const a = parseDay(from)
  const b = parseDay(to)
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000)
}

/** Day of week, 0 = Monday. */
export const weekday = (day: Day): number => {
  const { y, m, d } = parseDay(day)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

/** Today's date in a given IANA time zone. */
export const todayIn = (timeZone: string, now: Date = new Date()): Day => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
  return parts
}

/** "03/10/2026", the way a date is typed. */
export const formatDayInput = (day: Day): string => {
  const { y, m, d } = parseDay(day)
  return `${pad(d)}/${pad(m)}/${pad(y, 4)}`
}

/**
 * Reads a typed date: "3/10/2026", "03.10.26", "3/10", "3" or ISO. The month and year left out
 * are taken from `ref`. Null when the text is not a real day.
 */
export const parseDayInput = (text: string, ref: Day): Day | null => {
  const t = text.trim()
  if (isDay(t)) return t
  const parts = t.split(/[/.\-\s]+/)
  const [d, m, y] = parts
  if (parts.length > 3 || !d || !/^\d{1,2}$/.test(d) || (m !== undefined && !/^\d{1,2}$/.test(m))) return null
  if (y !== undefined && !/^(\d{2}|\d{4})$/.test(y)) return null
  const r = parseDay(ref)
  const year = y === undefined ? r.y : y.length === 2 ? 2000 + Number(y) : Number(y)
  const day = `${pad(year, 4)}-${pad(m === undefined ? r.m : Number(m))}-${pad(Number(d))}`
  return isDay(day) ? day : null
}

// --- French labels -----------------------------------------------------------

const MONTHS_LONG = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
]
const MONTHS_SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]

/** "Octobre 2026" */
export const formatMonthLong = (month: Month): string =>
  `${capitalize(MONTHS_LONG[Number(month.slice(5, 7)) - 1] ?? "")} ${month.slice(0, 4)}`

/** "octobre" */
export const formatMonthName = (month: Month): string => MONTHS_LONG[Number(month.slice(5, 7)) - 1] ?? ""

/** "oct." */
export const formatMonthShort = (month: Month): string => MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? ""

/** "2 oct." */
export const formatDayShort = (day: Day): string => {
  const { m, d } = parseDay(day)
  return `${d} ${MONTHS_SHORT[m - 1]}`
}

/** "2 oct. 2026" */
export const formatDayLong = (day: Day): string => {
  const { y, m, d } = parseDay(day)
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`
}

/** "Aujourd'hui", "Hier", "Demain", otherwise "2 oct.". */
export const formatDayRelative = (day: Day, today: Day): string => {
  const delta = diffDays(today, day)
  if (delta === 0) return "Aujourd'hui"
  if (delta === -1) return "Hier"
  if (delta === 1) return "Demain"
  return day.slice(0, 4) === today.slice(0, 4) ? formatDayShort(day) : formatDayLong(day)
}

import { addDays, type Day, daysInMonth, diffDays, makeDay, parseDay } from "./dates"

export type Recurrence = {
  /** "once": a single occurrence on the start date (interval is ignored). */
  readonly unit: "once" | "day" | "week" | "month" | "year"
  readonly interval: number
}

export const RECURRENCE_UNITS = ["once", "day", "week", "month", "year"] as const

export type ScheduleTiming = {
  readonly startDate: Day
  readonly endDate: Day | null
  readonly recurrence: Recurrence
}

/**
 * The n-th occurrence (n = 0 is the start date). Monthly and yearly occurrences keep
 * the start day of month, clamped to the end of shorter months (31 → 30 → 28…), so a
 * schedule starting on the 31st never drifts to the 28th forever.
 */
export const occurrence = (timing: ScheduleTiming, n: number): Day => {
  const { startDate, recurrence } = timing
  const step = recurrence.interval * n
  switch (recurrence.unit) {
    case "once":
      return startDate
    case "day":
      return addDays(startDate, step)
    case "week":
      return addDays(startDate, step * 7)
    case "month":
    case "year": {
      const { y, m, d } = parseDay(startDate)
      const months = recurrence.unit === "month" ? step : step * 12
      const total = y * 12 + (m - 1) + months
      const year = Math.floor(total / 12)
      const month = (total % 12) + 1
      const monthKey = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`
      return makeDay(year, month, Math.min(d, daysInMonth(monthKey)))
    }
  }
}

/** Average length of one period in days (Infinity for a one-off). */
export const periodDays = (r: Recurrence) =>
  r.unit === "once" ? Infinity : r.interval * (r.unit === "day" ? 1 : r.unit === "week" ? 7 : r.unit === "month" ? 30.44 : 365.25)

/** First occurrence on or after `from`, or null when the schedule ended. */
export const nextOnOrAfter = (timing: ScheduleTiming, from: Day): Day | null => {
  if (from <= timing.startDate) return timing.endDate !== null && timing.startDate > timing.endDate ? null : timing.startDate
  if (timing.recurrence.unit === "once") return null
  const elapsed = diffDays(timing.startDate, from)
  // Start a little before the estimate, then walk forward: clamping makes the exact index fuzzy.
  let n = Math.max(0, Math.floor(elapsed / periodDays(timing.recurrence)) - 1)
  for (let guard = 0; guard < 10_000; guard++, n++) {
    const day = occurrence(timing, n)
    if (timing.endDate !== null && day > timing.endDate) return null
    if (day >= from) return day
  }
  return null
}

/** Occurrences in [from, to], inclusive. */
export const occurrencesBetween = (timing: ScheduleTiming, from: Day, to: Day, limit = 400): Day[] => {
  const out: Day[] = []
  let day = nextOnOrAfter(timing, from)
  while (day !== null && day <= to && out.length < limit) {
    out.push(day)
    day = nextOnOrAfter(timing, addDays(day, 1))
  }
  return out
}

export const describeRecurrence = (r: Recurrence): string => {
  const n = r.interval
  switch (r.unit) {
    case "once":
      return "Une seule fois"
    case "day":
      return n === 1 ? "Tous les jours" : `Tous les ${n} jours`
    case "week":
      return n === 1 ? "Toutes les semaines" : `Toutes les ${n} semaines`
    case "month":
      return n === 1 ? "Tous les mois" : n === 3 ? "Tous les trimestres" : `Tous les ${n} mois`
    case "year":
      return n === 1 ? "Tous les ans" : `Tous les ${n} ans`
  }
}

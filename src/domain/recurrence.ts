import { addDays, type Day, daysInMonth, diffDays, makeDay, parseDay, weekday } from "./dates"

export type Recurrence = {
  /** "once": a single occurrence on the start date (interval is ignored). */
  readonly unit: "once" | "day" | "week" | "month" | "year"
  readonly interval: number
  /** An occurrence falling on a Saturday or a Sunday moves to the Monday after: banks book nothing on weekends. */
  readonly skipWeekend?: boolean
}

/** Same rhythm, an absent `skipWeekend` being the same as false. */
export const sameRecurrence = (a: Recurrence, b: Recurrence) =>
  a.unit === b.unit && a.interval === b.interval && !!a.skipWeekend === !!b.skipWeekend

/** The Monday after a Saturday or a Sunday, any other day unchanged. */
export const toMonday = (day: Day): Day => {
  const w = weekday(day)
  return w >= 5 ? addDays(day, 7 - w) : day
}

export const RECURRENCE_UNITS = ["once", "day", "week", "month", "year"] as const

export type ScheduleTiming = {
  readonly startDate: Day
  readonly endDate: Day | null
  readonly recurrence: Recurrence
}

/**
 * The n-th occurrence (n = 0 is the start date), then moved off the weekend when asked.
 * Each one is computed from the start date, never from the previous one, so a move to
 * Monday does not carry over to the next occurrences.
 */
export const occurrence = (timing: ScheduleTiming, n: number): Day => {
  const day = plannedOccurrence(timing, n)
  return timing.recurrence.skipWeekend ? toMonday(day) : day
}

/**
 * The n-th occurrence before any weekend move. Monthly and yearly occurrences keep the
 * start day of month, clamped to the end of shorter months (31 → 30 → 28…), so a
 * schedule starting on the 31st never drifts to the 28th forever.
 */
const plannedOccurrence = (timing: ScheduleTiming, n: number): Day => {
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

/**
 * First occurrence on or after `from`, or null when the schedule ended. The end date bounds
 * the planned days: one planned on a last Saturday still happens, on the Monday after.
 * Two planned days moved to the same Monday (a daily rhythm) make one occurrence.
 */
export const nextOnOrAfter = (timing: ScheduleTiming, from: Day): Day | null => {
  if (from <= timing.startDate) return timing.endDate !== null && timing.startDate > timing.endDate ? null : occurrence(timing, 0)
  if (timing.recurrence.unit === "once") return null
  const elapsed = diffDays(timing.startDate, from)
  // Start a little before the estimate, then walk forward: clamping makes the exact index fuzzy.
  let n = Math.max(0, Math.floor(elapsed / periodDays(timing.recurrence)) - 1)
  for (let guard = 0; guard < 10_000; guard++, n++) {
    const planned = plannedOccurrence(timing, n)
    if (timing.endDate !== null && planned > timing.endDate) return null
    const day = timing.recurrence.skipWeekend ? toMonday(planned) : planned
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

export const describeRecurrence = (r: Recurrence): string =>
  r.skipWeekend && r.unit !== "once" ? `${describeRhythm(r)} · reportée au lundi si week-end` : describeRhythm(r)

const describeRhythm = (r: Recurrence): string => {
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

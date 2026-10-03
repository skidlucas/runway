import { type Day, firstDay, lastDay, type Month, monthOf, monthRange } from "./dates"
import { nextOnOrAfter, occurrencesBetween, periodDays, type Recurrence, type ScheduleTiming } from "./recurrence"

export type PlannedSchedule = {
  readonly id: string
  readonly name: string
  readonly categoryId: string | null
  /** Signed cents, negative for an expense. */
  readonly amount: number
  readonly timing: ScheduleTiming
  readonly nextDate: Day
  readonly active: boolean
}

export type Remaining = {
  readonly count: number
  /** Positive cents: what is left to pay (or receive) until the end date. */
  readonly total: number
  readonly until: Day
}

export type PlannedLine = {
  readonly scheduleId: string
  readonly name: string
  readonly kind: "due" | "setAside"
  /** First occurrence in the month ("due"), or the next due date ("setAside"). */
  readonly date: Day
  /** Positive cents per occurrence. */
  readonly amount: number
  /** Occurrences in the month ("due"); 1 for "setAside". */
  readonly count: number
  /** Months until `date`, the current one included ("setAside" only). */
  readonly monthsLeft: number | null
  readonly remaining: Remaining | null
}

export type PlannedCategory = {
  /** Positive cents to budget this month so that every schedule is covered on time. */
  readonly amount: number
  /** Part of `amount` due this month. */
  readonly due: number
  /** Part of `amount` set aside for schedules falling in a later month. */
  readonly setAside: number
  /** Available at the start of the month, counted against the schedules falling later. */
  readonly saved: number
  readonly lines: ReadonlyArray<PlannedLine>
}

/** Paid at least once a month: budgeted as it falls, without setting money aside. */
export const isFrequent = (r: Recurrence) => periodDays(r) <= 31

const REMAINING_LIMIT = 10_000

/** What a schedule with an end date still has to pay, its next (possibly overdue) occurrence included. */
export const remainingOccurrences = (timing: ScheduleTiming, nextDate: Day, amount: number): Remaining | null => {
  if (timing.endDate === null) return null
  const dates = occurrencesBetween(timing, nextDate, timing.endDate, REMAINING_LIMIT)
  const until = dates.at(-1)
  return until ? { count: dates.length, total: dates.length * Math.abs(amount), until } : null
}

const ceilToEuro = (cents: number) => Math.ceil(cents / 100) * 100

/**
 * The smallest monthly amount that meets every later due date: for the k first dues
 * (sorted by date), what they cost beyond the money saved, spread over the months left.
 */
const setAsideNeed = (lines: ReadonlyArray<PlannedLine>, saved: number) => {
  let cumulated = 0
  let need = 0
  for (const line of lines) {
    cumulated += line.amount
    need = Math.max(need, ceilToEuro((cumulated - saved) / (line.monthsLeft ?? 1)))
  }
  return need
}

/**
 * Expense schedules of each category for `month`. Frequent ones count every occurrence of the
 * month, paid or not, so that the target stays put once one is booked; spaced-out ones (every
 * few months, yearly, one-off) are smoothed until their next date, net of `carryIn`.
 */
export const plannedByCategory = (
  schedules: ReadonlyArray<PlannedSchedule>,
  month: Month,
  carryIn: ReadonlyMap<string, number>,
): Map<string, PlannedCategory> => {
  const from = firstDay(month)
  const to = lastDay(month)
  const lines = new Map<string, PlannedLine[]>()
  for (const s of schedules) {
    if (!s.active || s.categoryId === null || s.amount >= 0) continue
    const base = { scheduleId: s.id, name: s.name, amount: -s.amount, remaining: remainingOccurrences(s.timing, s.nextDate, s.amount) }
    let line: PlannedLine | null = null
    if (isFrequent(s.timing.recurrence)) {
      const dates = occurrencesBetween(s.timing, from, to)
      if (dates[0]) line = { ...base, kind: "due", date: dates[0], count: dates.length, monthsLeft: null }
    } else {
      const date = nextOnOrAfter(s.timing, from)
      if (date) line = { ...base, kind: "setAside", date, count: 1, monthsLeft: monthRange(month, monthOf(date)).length }
    }
    if (!line) continue
    const list = lines.get(s.categoryId) ?? []
    list.push(line)
    lines.set(s.categoryId, list)
  }

  const planned = new Map<string, PlannedCategory>()
  for (const [categoryId, list] of lines) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const saved = Math.max(0, carryIn.get(categoryId) ?? 0)
    const due = list.filter((l) => l.kind === "due").reduce((sum, l) => sum + l.amount * l.count, 0)
    const setAside = setAsideNeed(list.filter((l) => l.kind === "setAside"), saved)
    planned.set(categoryId, { amount: due + setAside, due, setAside, saved, lines: list })
  }
  return planned
}

import { addDays, type Day, firstDay, lastDay, type Month, monthOf, monthRange } from "./dates"
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
  /** Day of the last transaction booked by the schedule. */
  readonly lastBooked: Day | null
}

export type Remaining = {
  readonly count: number
  /** Positive cents: what is left to pay (or receive) until the end date. */
  readonly total: number
  readonly until: Day
}

type PlannedLine = {
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
  /** Part of `amount` set aside for spaced-out schedules, this month's included. */
  readonly setAside: number
  /** Available at the start of the month: it pays this month's dues first, the rest counts as set aside. */
  readonly saved: number
  /** Positive cents falling this month, frequent and spaced-out alike. */
  readonly thisMonth: number
  /** `amount` minus what `saved` already covers: what the budget of the month must reach. */
  readonly toBudget: number
  readonly lines: ReadonlyArray<PlannedLine>
}

/** Paid at least once a month: budgeted as it falls, without setting money aside. */
const isFrequent = (r: Recurrence) => periodDays(r) <= 31

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
    const months = line.monthsLeft ?? 1
    need = Math.max(need, months === 1 ? cumulated - saved : ceilToEuro((cumulated - saved) / months))
  }
  return need
}

/**
 * The occurrence a spaced-out schedule sets money aside for in [from, to], and the months left
 * until it is paid. The last occurrence already booked or skipped counts in the month its
 * transaction is dated, not the month it was due: paid early (or skipped) before `from`, the next
 * one takes its place; paid this month ahead of its date, it is this month's.
 */
const spacedTarget = (s: PlannedSchedule, month: Month, from: Day, to: Day): { date: Day; monthsLeft: number } | null => {
  let date = nextOnOrAfter(s.timing, from)
  if (date === null) return null
  const lastClaimed = date < s.nextDate && (nextOnOrAfter(s.timing, addDays(date, 1)) ?? s.nextDate) >= s.nextDate
  if (lastClaimed) {
    if (s.lastBooked === null || s.lastBooked < from) date = nextOnOrAfter(s.timing, s.nextDate)
    else if (s.lastBooked <= to && date > to) return { date: s.lastBooked, monthsLeft: 1 }
  }
  return date === null ? null : { date, monthsLeft: monthRange(month, monthOf(date)).length }
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
      const target = spacedTarget(s, month, from, to)
      if (target) line = { ...base, kind: "setAside", count: 1, ...target }
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
    const spaced = list.filter((l) => l.kind === "setAside")
    const setAside = setAsideNeed(spaced, Math.max(0, saved - due))
    const thisMonth = due + spaced.filter((l) => l.monthsLeft === 1).reduce((sum, l) => sum + l.amount, 0)
    const amount = due + setAside
    planned.set(categoryId, { amount, due, setAside, saved, thisMonth, toBudget: amount - Math.min(due, saved), lines: list })
  }
  return planned
}

export type PlannedStatus = "short" | "upcoming" | "covered"

/**
 * "short": the envelope cannot pay what falls this month. "upcoming": this month is paid, but
 * less is set aside than the later schedules need. "covered": both are met.
 */
export const plannedStatus = (planned: PlannedCategory, budgeted: number): PlannedStatus =>
  planned.saved + budgeted < planned.thisMonth ? "short" : budgeted < planned.toBudget ? "upcoming" : "covered"

import { addDays, compareIso, type Day, daysInMonth, diffDays, firstDay, lastDay, type Month } from "./dates"

/** How many months after the current one the forecast can be opened on. */
export const MAX_FORECAST_MONTHS = 12

export type UpcomingItem = {
  readonly date: Day
  readonly name: string
  /** Signed cents. */
  readonly amount: number
  readonly categoryId: string | null
  readonly source: "schedule" | "transaction"
  readonly scheduleId: string | null
  /** An occurrence left unpaid: dated today, since it is still to pay. */
  readonly overdue: boolean
}

export type ForecastInput = {
  readonly today: Day
  /** The current month or a later one. */
  readonly month: Month
  /** Balance of the forecast accounts at the end of each day of the month up to today. */
  readonly dailyBalances: ReadonlyMap<Day, number>
  /** Balance before the first day of the month: projected when the month has not started yet. */
  readonly openingBalance: number
  readonly upcoming: ReadonlyArray<UpcomingItem>
}

export type UpcomingTag = "scheduled" | "income" | "booked"

type ForecastDay = { date: Day; balance: number; kind: "past" | "today" | "future"; hasSchedule: boolean }

export type Forecast = {
  month: Month
  today: Day
  /** The month starts after today: nothing in it is real yet, every day is projected. */
  isFuture: boolean
  /** In a month yet to come, the projected balance it opens with. */
  balanceToday: number
  daysLeft: number
  /** Scheduled expenses still to come this month. */
  scheduledUpcoming: number
  upcomingIncome: number
  /** Future-dated transactions already entered, not yet in today's balance. */
  bookedUpcoming: number
  projectedEndBalance: number
  days: ForecastDay[]
  upcoming: Array<UpcomingItem & { tag: UpcomingTag }>
}

/**
 * Where the forecast accounts land at the end of the month, from what is already known:
 * today's balance − scheduled expenses + scheduled income − transactions already entered with
 * a future date. The budget is left out: it is money set aside, not a spending plan.
 */
export const computeForecast = (input: ForecastInput): Forecast => {
  const { today, month } = input
  const start = firstDay(month)
  const end = lastDay(month)
  const isFuture = start > today
  const from: Day = isFuture ? start : today
  const lastRealDay: Day = isFuture ? addDays(start, -1) : today
  const daysLeft = diffDays(from, end) + 1

  let balanceToday = input.openingBalance
  for (const [day, balance] of input.dailyBalances) if (day <= lastRealDay) balanceToday = balance

  const upcoming = input.upcoming
    .filter((u) => u.date >= from && u.date <= end)
    .sort((a, b) => compareIso(a.date, b.date))
    .map((u) => {
      const tag: UpcomingTag =
        u.source === "transaction" ? "booked" : u.amount > 0 ? "income" : "scheduled"
      return { ...u, tag }
    })

  const sum = (tag: UpcomingTag) => upcoming.filter((u) => u.tag === tag).reduce((a, u) => a + u.amount, 0)
  const scheduledUpcoming = -sum("scheduled")
  const upcomingIncome = sum("income")
  const bookedUpcoming = -sum("booked")
  const projectedEndBalance = balanceToday - scheduledUpcoming + upcomingIncome - bookedUpcoming

  // Day-by-day series: real balances until today, then each dated item on its day.
  const datedByDay = new Map<Day, number>()
  for (const u of upcoming) datedByDay.set(u.date, (datedByDay.get(u.date) ?? 0) + u.amount)
  const days: ForecastDay[] = []
  let running = input.openingBalance
  // What is due today (overdue occurrences included) is not in today's balance yet: it weighs from tomorrow.
  let projected = balanceToday + (isFuture ? 0 : (datedByDay.get(today) ?? 0))
  for (let d = 1; d <= daysInMonth(month); d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`
    if (date <= lastRealDay) {
      running = input.dailyBalances.get(date) ?? running
      const isToday = date === today
      days.push({ date, balance: running, kind: isToday ? "today" : "past", hasSchedule: isToday && datedByDay.has(date) })
    } else {
      projected += datedByDay.get(date) ?? 0
      days.push({ date, balance: projected, kind: "future", hasSchedule: datedByDay.has(date) })
    }
  }

  return {
    month,
    today,
    isFuture,
    balanceToday,
    daysLeft,
    scheduledUpcoming,
    upcomingIncome,
    bookedUpcoming,
    projectedEndBalance,
    days,
    upcoming,
  }
}

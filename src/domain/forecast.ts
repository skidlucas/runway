import { type Day, daysInMonth, diffDays, lastDay, type Month } from "./dates"

export type ForecastCategory = {
  readonly id: string
  readonly name: string
  readonly isIncome: boolean
  readonly hidden: boolean
  readonly budgeted: number
  /** Positive amount spent this month. */
  readonly spent: number
  readonly available: number
}

export type UpcomingItem = {
  readonly date: Day
  readonly name: string
  /** Signed cents. */
  readonly amount: number
  readonly categoryId: string | null
  readonly source: "schedule" | "transaction"
  readonly scheduleId: string | null
}

export type ForecastInput = {
  readonly today: Day
  readonly month: Month
  readonly categories: ReadonlyArray<ForecastCategory>
  /** Balance of the forecast accounts at the end of each day of the month up to today. */
  readonly dailyBalances: ReadonlyMap<Day, number>
  /** Balance before the first day of the month. */
  readonly openingBalance: number
  readonly upcoming: ReadonlyArray<UpcomingItem>
  /**
   * Whether what the budget still allows to spend comes out of these accounts. Off for a
   * savings account: its scheduled expenses then count in full on their date.
   */
  readonly withBudget?: boolean
  /**
   * Part of the remaining budget spent from these accounts, from 0 to 1 (1 by default). The
   * budget is shared by every budget account: a checking account carries most of it, savings none.
   */
  readonly budgetShare?: number
}

export type UpcomingTag =
  | { kind: "category"; label: string }
  | { kind: "unbudgeted" }
  | { kind: "scheduled" }
  | { kind: "income" }
  | { kind: "booked" }

export type ForecastDay = { date: Day; balance: number; kind: "past" | "today" | "future"; hasSchedule: boolean }

export type Forecast = {
  month: Month
  today: Day
  balanceToday: number
  budgeted: number
  spent: number
  /** Σ max(0, budgeted − spent) over expense categories. */
  remainingToSpend: number
  daysLeft: number
  perDay: number
  /** Upcoming expenses no budget category accounts for. */
  unbudgetedUpcoming: number
  /** Upcoming scheduled expenses counted in full because the budget is left out. */
  scheduledUpcoming: number
  withBudget: boolean
  budgetShare: number
  upcomingIncome: number
  /** Future-dated transactions already entered, not yet in today's balance. */
  bookedUpcoming: number
  projectedEndBalance: number
  days: ForecastDay[]
  upcoming: Array<UpcomingItem & { tag: UpcomingTag }>
  watch: Array<{ id: string; name: string; available: number; ratio: number; overspent: boolean }>
}

/**
 * "Reste prévu": how much can still be spent this month and where the forecast
 * accounts land at the end of it.
 *
 * Projected end balance = today's balance − what the budget still allows to spend
 * − scheduled expenses no category budgets for + scheduled income
 * − transactions already entered with a future date. Without the budget, every scheduled
 * expense counts instead.
 */
export const computeForecast = (input: ForecastInput): Forecast => {
  const { today, month } = input
  const end = lastDay(month)
  const inMonth = today.slice(0, 7) === month
  const isPast = end < today
  const effectiveToday: Day = inMonth ? today : isPast ? end : `${month}-01`
  const withBudget = input.withBudget ?? true
  const budgetShare = Math.min(1, Math.max(0, input.budgetShare ?? 1))

  const expense = input.categories.filter((c) => !c.isIncome)
  const budgetById = new Map(expense.map((c) => [c.id, c]))
  const remainingToSpend =
    isPast || !withBudget ? 0 : Math.round(expense.reduce((acc, c) => acc + Math.max(0, c.budgeted - c.spent), 0) * budgetShare)
  const budgeted = expense.reduce((acc, c) => acc + c.budgeted, 0)
  const spent = expense.reduce((acc, c) => acc + c.spent, 0)

  const daysLeft = isPast ? 0 : diffDays(effectiveToday, end) + 1
  const perDay = daysLeft > 0 ? Math.floor(remainingToSpend / daysLeft) : 0

  let balanceToday = input.openingBalance
  for (const [day, balance] of input.dailyBalances) if (day <= effectiveToday) balanceToday = balance

  const upcoming = input.upcoming
    .filter((u) => u.date >= effectiveToday && u.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((u) => {
      let tag: UpcomingTag
      if (u.source === "transaction") tag = { kind: "booked" }
      else if (u.amount > 0) tag = { kind: "income" }
      else if (!withBudget) tag = { kind: "scheduled" }
      else {
        const category = u.categoryId ? budgetById.get(u.categoryId) : undefined
        tag = category && category.budgeted > 0 ? { kind: "category", label: category.name } : { kind: "unbudgeted" }
      }
      return { ...u, tag }
    })

  const unbudgetedUpcoming = upcoming.filter((u) => u.tag.kind === "unbudgeted").reduce((a, u) => a - u.amount, 0)
  const scheduledUpcoming = upcoming.filter((u) => u.tag.kind === "scheduled").reduce((a, u) => a - u.amount, 0)
  const upcomingIncome = upcoming.filter((u) => u.tag.kind === "income").reduce((a, u) => a + u.amount, 0)
  const bookedUpcoming = upcoming.filter((u) => u.tag.kind === "booked").reduce((a, u) => a - u.amount, 0)
  const projectedEndBalance =
    balanceToday - remainingToSpend - unbudgetedUpcoming - scheduledUpcoming + upcomingIncome - bookedUpcoming

  // Day-by-day series: real balances until today, then the remaining budget spread
  // evenly over the days after today, plus the dated items on their day.
  const days: ForecastDay[] = []
  const total = daysInMonth(month)
  const futureDays = Math.max(0, diffDays(effectiveToday, end))
  const spread = futureDays > 0 ? remainingToSpend / futureDays : 0
  let running = input.openingBalance
  let projected = balanceToday
  const datedByDay = new Map<Day, number>()
  for (const u of upcoming) {
    if (u.tag.kind === "category") continue
    datedByDay.set(u.date, (datedByDay.get(u.date) ?? 0) + u.amount)
  }
  for (let d = 1; d <= total; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`
    if (date <= effectiveToday) {
      running = input.dailyBalances.get(date) ?? running
      days.push({ date, balance: running, kind: date === effectiveToday && inMonth ? "today" : "past", hasSchedule: false })
    } else {
      projected = projected - spread + (datedByDay.get(date) ?? 0)
      days.push({
        date,
        balance: Math.round(projected),
        kind: "future",
        hasSchedule: upcoming.some((u) => u.date === date),
      })
    }
  }
  // Rounding of the even spread can leave a few cents: pin the last day to the exact projection.
  const last = days[days.length - 1]
  if (last && last.kind === "future") last.balance = projectedEndBalance
  // Items dated today belong to today's bar but are not in its real balance yet.
  if (inMonth) {
    const todayItems = datedByDay.get(effectiveToday)
    if (todayItems) {
      const todayDay = days.find((d) => d.date === effectiveToday)
      if (todayDay) todayDay.hasSchedule = true
    }
  }

  const watch = expense
    .filter((c) => !c.hidden && (c.available < 0 || (c.available > 0 && c.budgeted > 0 && c.spent / c.budgeted >= 0.8)))
    .map((c) => ({
      id: c.id,
      name: c.name,
      available: c.available,
      ratio: c.budgeted > 0 ? c.spent / c.budgeted : 1,
      overspent: c.available < 0,
    }))
    .sort((a, b) => Number(b.overspent) - Number(a.overspent) || a.available - b.available)

  return {
    month,
    today: effectiveToday,
    balanceToday,
    budgeted,
    spent,
    remainingToSpend,
    daysLeft,
    perDay,
    unbudgetedUpcoming,
    scheduledUpcoming,
    withBudget,
    budgetShare,
    upcomingIncome,
    bookedUpcoming,
    projectedEndBalance,
    days,
    upcoming,
    watch,
  }
}


import { addDays, compareIso, type Day, diffDays } from "./dates"
import type { Recurrence } from "./recurrence"
import { nextOnOrAfter } from "./recurrence"

export type HistoryTransaction = {
  readonly payeeId: string
  readonly payeeName: string
  readonly date: Day
  readonly amount: number
  readonly categoryId: string | null
  readonly accountId: string
}

export type RecurringCandidate = {
  readonly payeeId: string
  readonly payeeName: string
  readonly accountId: string
  readonly categoryId: string | null
  /** Median amount of the occurrences, signed. */
  readonly amount: number
  readonly recurrence: Recurrence
  readonly occurrences: number
  readonly firstDate: Day
  readonly lastDate: Day
  readonly nextDate: Day
  /** 0..1, how regular the dates and amounts are. */
  readonly confidence: number
}

type Cadence = { readonly recurrence: Recurrence; readonly days: number; readonly tolerance: number }

const CADENCES: ReadonlyArray<Cadence> = [
  { recurrence: { unit: "week", interval: 1 }, days: 7, tolerance: 1 },
  { recurrence: { unit: "week", interval: 2 }, days: 14, tolerance: 2 },
  { recurrence: { unit: "month", interval: 1 }, days: 30.44, tolerance: 4 },
  { recurrence: { unit: "month", interval: 3 }, days: 91.3, tolerance: 8 },
  { recurrence: { unit: "year", interval: 1 }, days: 365.25, tolerance: 12 },
]

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

const amountsAreStable = (amounts: ReadonlyArray<number>, reference: number) => {
  const tolerance = Math.max(Math.abs(reference) * 0.15, 300)
  return amounts.filter((a) => Math.abs(a - reference) <= tolerance).length / amounts.length
}

/**
 * Finds payees that are paid (or pay) at a regular cadence with a stable amount.
 * Needs at least `minOccurrences` transactions; groups by payee and account so a
 * subscription paid from two cards is seen as two candidates.
 * Linear in the number of transactions (one sort per payee group).
 */
export const detectRecurring = (
  history: ReadonlyArray<HistoryTransaction>,
  today: Day,
  options: { minOccurrences?: number } = {},
): RecurringCandidate[] => {
  const minOccurrences = options.minOccurrences ?? 3
  const groups = new Map<string, HistoryTransaction[]>()
  for (const tx of history) {
    if (tx.amount === 0) continue
    const sign = tx.amount < 0 ? "-" : "+"
    const key = `${tx.payeeId}|${tx.accountId}|${sign}`
    const list = groups.get(key)
    if (list) list.push(tx)
    else groups.set(key, [tx])
  }

  const candidates: RecurringCandidate[] = []
  for (const list of groups.values()) {
    if (list.length < minOccurrences) continue
    list.sort((a, b) => compareIso(a.date, b.date))
    const gaps: number[] = []
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]
      const curr = list[i]
      if (prev && curr) gaps.push(diffDays(prev.date, curr.date))
    }
    // Several transactions on the same day (e.g. groceries) are not a subscription.
    if (gaps.some((g) => g === 0)) continue
    const typicalGap = median(gaps)
    const cadence = CADENCES.find((c) => Math.abs(typicalGap - c.days) <= c.tolerance)
    if (!cadence) continue
    const regular = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.tolerance * 1.5).length / gaps.length
    const amount = Math.round(median(list.map((t) => t.amount)))
    const stable = amountsAreStable(
      list.map((t) => t.amount),
      amount,
    )
    if (regular < 0.75 || stable < 0.75) continue

    const first = list[0]
    const last = list[list.length - 1]
    if (!first || !last) continue
    // A series that stopped more than two periods ago is no longer active.
    if (diffDays(last.date, today) > cadence.days * 2 + cadence.tolerance) continue

    const nextDate =
      nextOnOrAfter({ startDate: last.date, endDate: null, recurrence: cadence.recurrence }, addDays(today, 0)) ??
      today
    const categories = new Map<string | null, number>()
    for (const t of list) categories.set(t.categoryId, (categories.get(t.categoryId) ?? 0) + 1)
    const categoryId = [...categories.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    candidates.push({
      payeeId: last.payeeId,
      payeeName: last.payeeName,
      accountId: last.accountId,
      categoryId,
      amount,
      recurrence: cadence.recurrence,
      occurrences: list.length,
      firstDate: first.date,
      lastDate: last.date,
      nextDate,
      confidence: Math.round(regular * stable * 100) / 100,
    })
  }
  return candidates.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
}

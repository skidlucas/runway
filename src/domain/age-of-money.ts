import { type Day, diffDays } from "./dates"

/** Money in and out of the budget accounts on one day, in cents (both positive). */
export type MoneyDay = { readonly date: Day; readonly inflow: number; readonly outflow: number }
/** One outflow, positive cents. */
export type Outflow = { readonly date: Day; readonly amount: number }

/**
 * YNAB's Age of Money: every outflow spends the oldest money received first, and the age of
 * an outflow is how many days that money waited. The result is the average age over `sample`,
 * the last outflows in chronological order; `days` carries all the other movements, aggregated.
 * Null when no sampled outflow was covered by money received.
 */
export const ageOfMoney = (days: ReadonlyArray<MoneyDay>, sample: ReadonlyArray<Outflow>): number | null => {
  type Event = { date: Day; rank: number; amount: number }
  const events: Event[] = []
  for (const d of days) {
    if (d.inflow > 0) events.push({ date: d.date, rank: 0, amount: d.inflow })
    if (d.outflow > 0) events.push({ date: d.date, rank: 1, amount: d.outflow })
  }
  sample.forEach((o, i) => events.push({ date: o.date, rank: 2 + i, amount: o.amount }))
  // Within a day: money received first, then the earlier outflows, then the sampled ones.
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rank - b.rank))

  const queue: Array<{ date: Day; left: number }> = []
  let head = 0
  const ages: number[] = []
  for (const e of events) {
    if (e.rank === 0) {
      queue.push({ date: e.date, left: e.amount })
      continue
    }
    let need = e.amount
    let funded = 0
    let weighted = 0
    while (need > 0 && head < queue.length) {
      const bucket = queue[head]!
      const take = Math.min(need, bucket.left)
      bucket.left -= take
      need -= take
      funded += take
      weighted += take * diffDays(bucket.date, e.date)
      if (bucket.left === 0) head++
    }
    if (e.rank >= 2 && funded > 0) ages.push(weighted / funded)
  }
  return ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null
}

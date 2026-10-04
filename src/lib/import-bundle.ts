import type { BundleExtras as BundleExtrasSchema, BundleStructure as BundleStructureSchema, IdMaps as IdMapsSchema } from "~/server/schemas"

// Source-agnostic description of data to import. Ids are the source ids: they are
// kept when free, which makes re-importing the same file idempotent.

export type BundleTransaction = {
  id: string
  accountId: string
  date: string
  amount: number
  payeeId: string | null
  categoryId: string | null
  notes: string | null
  cleared: boolean
  reconciled: boolean
  transferId: string | null
  isParent: boolean
  parentId: string | null
  importedId: string | null
  importedPayee: string | null
  startingBalance: boolean
  /** Runway backups only: the schedule this operation was booked from. */
  scheduleId?: string | null
  /** Orders the operations of a same day; the server stamps them itself when absent. */
  createdAt?: string | null
}

/** Structure part of a bundle: everything except transactions, sent in one request. */
export type BundleStructure = typeof BundleStructureSchema.Type
export type BundleRule = BundleStructure["rules"][number]
export type BundleSchedule = BundleStructure["schedules"][number]
export type BundleExtras = typeof BundleExtrasSchema.Type
export type IdMaps = typeof IdMapsSchema.Type

export type ImportBundle = BundleStructure & {
  transactions: BundleTransaction[]
  /** Runway backups only: wealth, saved insight views and dashboards, restored after the structure. */
  extras?: BundleExtras
  /** Things that exist in the source but cannot be represented, for the preview. */
  skipped: { rules: number; schedules: number; transactions: number; budgets: number }
  /** Things imported in a simpler form than in the source, for the preview. */
  approximated: { schedules: number }
}

/**
 * Creation stamps that keep a source's order within a day, since the register lists a day's
 * operations newest stamp first. `ranks` orders the rows from oldest to newest; ties keep
 * their input order. The stamps end at `end` so later entries still come out on top.
 */
export const orderStamps = (ranks: ReadonlyArray<number>, end = Date.now()): string[] => {
  const order = ranks.map((_, i) => i).sort((a, b) => (ranks[a] ?? 0) - (ranks[b] ?? 0) || a - b)
  const stamps = Array.from({ length: ranks.length }, () => "")
  order.forEach((index, position) => {
    stamps[index] = new Date(end - ranks.length + position).toISOString()
  })
  return stamps
}

/** Bank exports list operations newest first or oldest first; a day keeps the order of the file. */
export const fileOrderStamps = (dates: ReadonlyArray<string>, end = Date.now()): string[] => {
  const newestFirst = fileIsNewestFirst(dates)
  return orderStamps(dates.map((_, i) => (newestFirst ? -i : i)), end)
}

/** Read from the first and last dates, else from the first change of day; a single-day file is taken as newest first, like most banks. */
const fileIsNewestFirst = (dates: ReadonlyArray<string>) => {
  const first = dates[0] ?? ""
  const last = dates[dates.length - 1] ?? ""
  if (first !== last) return first > last
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] !== dates[i - 1]) return dates[i - 1]! > dates[i]!
  }
  return true
}

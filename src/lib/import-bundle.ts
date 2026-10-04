import type { Recurrence } from "~/domain/recurrence"
import type { RuleAction, RuleCondition } from "~/domain/rules"
import type { ExportMeta } from "~/server/services/import-export"

// Source-agnostic description of data to import. Ids are the source ids: they are
// kept when free, which makes re-importing the same file idempotent.

export type BundleAccount = {
  id: string
  name: string
  offBudget: boolean
  closed: boolean
  kind?: string
  /** Runway backups only. */
  inForecast?: boolean
  lastReconciledAt?: string | null
}
export type BundleGroup = { id: string; name: string; isIncome: boolean; hidden: boolean; sortOrder: number }
export type BundleCategory = {
  id: string
  groupId: string
  name: string
  isIncome: boolean
  hidden: boolean
  sortOrder: number
}
export type BundlePayee = { id: string; name: string; transferAccountId: string | null }
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
export type BundleBudget = { month: string; categoryId: string; amount: number; carryover: boolean }
export type BundleRule = {
  conditionsOp: "and" | "or"
  conditions: RuleCondition[]
  /** Payee and category ids in actions are source ids. */
  actions: RuleAction[]
  /** Runway backups only; imported rules are enabled otherwise. */
  enabled?: boolean
  /** Runway backups only; marked "imported" otherwise. */
  origin?: "manual" | "suggested" | "imported"
}
export type BundleSchedule = {
  id: string
  name: string | null
  payeeId: string | null
  accountId: string
  categoryId: string | null
  amount: number
  recurrence: Recurrence
  startDate: string
  nextDate: string
  endDate: string | null
  autoPost: boolean
  active: boolean
}

export type ImportBundle = {
  source: "actual" | "runway"
  name: string
  accounts: BundleAccount[]
  groups: BundleGroup[]
  categories: BundleCategory[]
  payees: BundlePayee[]
  transactions: BundleTransaction[]
  budgets: BundleBudget[]
  buffered: Array<{ month: string; amount: number }>
  rules: BundleRule[]
  schedules: BundleSchedule[]
  /** Runway backups only: wealth, saved insight views and dashboards, restored after the structure. */
  extras?: BundleExtras
  /** Things that exist in the source but cannot be represented, for the preview. */
  skipped: { rules: number; schedules: number; transactions: number }
}

/** Structure part of a bundle: everything except transactions, sent in one request. */
export type BundleStructure = Omit<ImportBundle, "transactions" | "skipped" | "extras">

export type BundleExtras = Pick<ExportMeta, "assets" | "valuations" | "savedViews" | "dashboards">

export type IdMaps = {
  accounts: Record<string, string>
  groups: Record<string, string>
  categories: Record<string, string>
  payees: Record<string, string>
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

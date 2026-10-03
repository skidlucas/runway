import type { Recurrence } from "~/domain/recurrence"
import type { RuleAction, RuleCondition } from "~/domain/rules"
import type { ExportMeta } from "~/server/services/import-export"

// Source-agnostic description of data to import. Ids are the source ids: they are
// kept when free, which makes re-importing the same file idempotent.

export type BundleAccount = { id: string; name: string; offBudget: boolean; closed: boolean; kind?: string }
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
}
export type BundleBudget = { month: string; categoryId: string; amount: number; carryover: boolean }
export type BundleRule = {
  conditionsOp: "and" | "or"
  conditions: RuleCondition[]
  /** Payee and category ids in actions are source ids. */
  actions: RuleAction[]
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
  /** Runway backups only: wealth and saved insight views, restored after the structure. */
  extras?: BundleExtras
  /** Things that exist in the source but cannot be represented, for the preview. */
  skipped: { rules: number; schedules: number; transactions: number }
}

/** Structure part of a bundle: everything except transactions, sent in one request. */
export type BundleStructure = Omit<ImportBundle, "transactions" | "skipped" | "extras">

export type BundleExtras = Pick<ExportMeta, "assets" | "valuations" | "savedViews">

export type IdMaps = {
  accounts: Record<string, string>
  groups: Record<string, string>
  categories: Record<string, string>
  payees: Record<string, string>
}

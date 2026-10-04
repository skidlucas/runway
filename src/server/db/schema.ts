import { sql } from "drizzle-orm"
import type { Recurrence } from "../../domain/recurrence"
import type { RuleAction, RuleCondition } from "../../domain/rules"
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Amounts are integer cents everywhere. Dates are ISO strings: `YYYY-MM-DD` for days, `YYYY-MM` for months.

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["checking", "savings", "credit", "investment", "other"] })
    .notNull()
    .default("checking"),
  offBudget: integer("off_budget", { mode: "boolean" }).notNull().default(false),
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
  // Whether the balance counts as "money available now" in the end-of-month projection.
  inForecast: integer("in_forecast", { mode: "boolean" }).notNull().default(true),
  sortOrder: real("sort_order").notNull().default(0),
  lastReconciledAt: text("last_reconciled_at"),
  createdAt: createdAt(),
})

export const categoryGroups = sqliteTable("category_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  isIncome: integer("is_income", { mode: "boolean" }).notNull().default(false),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  sortOrder: real("sort_order").notNull().default(0),
})

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => categoryGroups.id),
    name: text("name").notNull(),
    isIncome: integer("is_income", { mode: "boolean" }).notNull().default(false),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    sortOrder: real("sort_order").notNull().default(0),
  },
  (t) => [index("categories_group_idx").on(t.groupId)],
)

export const payees = sqliteTable(
  "payees",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Set for the synthetic payee that represents "transfer to/from this account".
    transferAccountId: text("transfer_account_id").references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [index("payees_name_idx").on(t.name), uniqueIndex("payees_transfer_idx").on(t.transferAccountId)],
)

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    date: text("date").notNull(),
    amount: integer("amount").notNull(),
    payeeId: text("payee_id").references(() => payees.id),
    categoryId: text("category_id").references(() => categories.id),
    notes: text("notes"),
    cleared: integer("cleared", { mode: "boolean" }).notNull().default(false),
    reconciled: integer("reconciled", { mode: "boolean" }).notNull().default(false),
    // The mirrored transaction on the other account of a transfer.
    transferId: text("transfer_id"),
    // Split transactions: the parent carries the total, children carry the categories.
    // Budget aggregates must skip parents to avoid double counting.
    isParent: integer("is_parent", { mode: "boolean" }).notNull().default(false),
    parentId: text("parent_id"),
    importedId: text("imported_id"),
    importedPayee: text("imported_payee"),
    scheduleId: text("schedule_id"),
    startingBalance: integer("starting_balance", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // Registers page through these in display order (date, then entry order).
    index("tx_account_order_idx").on(t.accountId, t.date, t.createdAt, t.id),
    index("tx_order_idx").on(t.date, t.createdAt, t.id),
    index("tx_category_order_idx").on(t.categoryId, t.date, t.createdAt, t.id),
    index("tx_date_category_idx").on(t.date, t.categoryId),
    // With the date, a payee's last category is read from the index instead of sorting its history.
    index("tx_payee_date_idx").on(t.payeeId, t.date),
    // Partial indexes: nearly every row has these columns null. A full index on parent_id made
    // SQLite pick it for `parent_id IS NULL`, which matches the whole table.
    index("tx_parent_idx").on(t.parentId).where(sql`parent_id IS NOT NULL`),
    index("tx_transfer_idx").on(t.transferId).where(sql`transfer_id IS NOT NULL`),
    index("tx_schedule_idx").on(t.scheduleId).where(sql`schedule_id IS NOT NULL`),
  ],
)

export const budgets = sqliteTable(
  "budgets",
  {
    month: text("month").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    amount: integer("amount").notNull().default(0),
    // When true, a negative leftover of this month rolls into the next month of the
    // category instead of being taken from next month's "to budget".
    carryover: integer("carryover", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.month, t.categoryId] })],
)

// Money held back from "to budget" for the next month (Actual's "hold for next month").
export const budgetMonths = sqliteTable("budget_months", {
  month: text("month").primaryKey(),
  buffered: integer("buffered").notNull().default(0),
})

export const rules = sqliteTable("rules", {
  id: text("id").primaryKey(),
  conditionsOp: text("conditions_op", { enum: ["and", "or"] })
    .notNull()
    .default("and"),
  conditions: text("conditions", { mode: "json" }).$type<RuleCondition[]>().notNull(),
  actions: text("actions", { mode: "json" }).$type<RuleAction[]>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  // How the rule was born: typed by hand, accepted from a suggestion, imported from Actual.
  origin: text("origin", { enum: ["manual", "suggested", "imported"] })
    .notNull()
    .default("manual"),
  sortOrder: real("sort_order").notNull().default(0),
  createdAt: createdAt(),
})

export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    payeeId: text("payee_id").references(() => payees.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    categoryId: text("category_id").references(() => categories.id),
    amount: integer("amount").notNull(),
    recurrence: text("recurrence", { mode: "json" }).$type<Recurrence>().notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    nextDate: text("next_date").notNull(),
    // Post the transaction automatically on its date instead of only showing it as upcoming.
    autoPost: integer("auto_post", { mode: "boolean" }).notNull().default(false),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("schedules_next_idx").on(t.nextDate)],
)

export type ValuationSource =
  | { kind: "manual" }
  // `label` is the display name picked in the search ("Bitcoin (BTC)", "Lyon 7e Arrondissement").
  | { kind: "crypto"; coinId: string; quantity: number; label?: string }
  | { kind: "stock"; symbol: string; quantity: number; label?: string }
  | { kind: "real_estate"; inseeCode: string; surface: number; propertyType: "apartment" | "house"; label?: string }
  | { kind: "loan"; principal: number; annualRatePct: number; months: number; startDate: string }

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", {
    enum: ["real_estate", "investment", "crypto", "vehicle", "watch", "art", "cash", "loan", "other"],
  }).notNull(),
  isLiability: integer("is_liability", { mode: "boolean" }).notNull().default(false),
  subtitle: text("subtitle"),
  purchaseAmount: integer("purchase_amount"),
  purchaseDate: text("purchase_date"),
  declaredAmount: integer("declared_amount"),
  declaredDate: text("declared_date"),
  retained: text("retained", { enum: ["purchase", "declared", "estimated"] })
    .notNull()
    .default("estimated"),
  /** Part owned, in basis points (5 000 = 50 %). Amounts are stored for the whole asset. */
  share: integer("share").notNull().default(10000),
  source: text("source", { mode: "json" }).$type<ValuationSource>().notNull(),
  notes: text("notes"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
})

export const assetValuations = sqliteTable(
  "asset_valuations",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    amount: integer("amount").notNull(),
    source: text("source").notNull(),
    // Unit price used to compute the amount, kept to explain the estimation.
    unitPrice: real("unit_price"),
    // Last month covered by the source data, when it lags behind `date` (DVF publishes sales
    // several months late).
    asOf: text("as_of"),
    automatic: integer("automatic", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("asset_valuations_asset_date_idx").on(t.assetId, t.date)],
)

export type InsightViewConfig = {
  measure: "expenses" | "income"
  target: { kind: "all" } | { kind: "category" | "group" | "payee"; id: string }
  months: number
  rolling: 0 | 3 | 6 | 12
}

export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }).$type<InsightViewConfig>().notNull(),
  sortOrder: real("sort_order").notNull().default(0),
})

export type DashboardWidgetKind =
  | "net_worth"
  | "wealth"
  | "cash_flow"
  | "spending_comparison"
  | "category_spending"
  | "account_balances"
  | "upcoming"
  | "insight_view"

export type DashboardWidget = {
  id: string
  kind: DashboardWidgetKind
  /** Columns taken on the 3-column desktop grid. */
  size: 1 | 2 | 3
  /** Period of the time-based widgets (net worth, cash flow, category spending). */
  months?: number
  /** Horizon of the `upcoming` widget. */
  days?: number
  /** Saved insights view shown by an `insight_view` widget. */
  viewId?: string
}

export const dashboards = sqliteTable("dashboards", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  widgets: text("widgets", { mode: "json" }).$type<DashboardWidget[]>().notNull(),
  sortOrder: real("sort_order").notNull().default(0),
})

// Deleted transactions, kept a day so a deletion can be undone. `row` is the transaction as JSON.
export const transactionTrash = sqliteTable(
  "transaction_trash",
  {
    undoId: text("undo_id").notNull(),
    deletedAt: integer("deleted_at").notNull(),
    row: text("row").notNull(),
  },
  (t) => [index("transaction_trash_undo_idx").on(t.undoId), index("transaction_trash_deleted_idx").on(t.deletedAt)],
)

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
})

// Login attempts per client (`ip:<address>`) plus one `global` row. Times are epoch milliseconds.
export const loginAttempts = sqliteTable("login_attempts", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  windowStart: integer("window_start").notNull(),
  lockedUntil: integer("locked_until").notNull(),
})

// Cached AI output so a page load never waits on (or pays for) a model call twice.
export const aiCache = sqliteTable("ai_cache", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  createdAt: createdAt(),
})

import { sql } from "drizzle-orm"
import { ACCOUNT_KINDS } from "../../domain/accounts"
import type { Recurrence } from "../../domain/recurrence"
import { RULE_CONDITIONS_OPS, RULE_ORIGINS, type RuleAction, type RuleCondition } from "../../domain/rules"
import { ASSET_TYPES, RETAINED_KINDS } from "../../domain/wealth"
import type { DashboardWidget as DashboardWidgetSchema, InsightQuery, ValuationSource as ValuationSourceSchema } from "../schemas"
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Amounts are integer cents everywhere. Dates are ISO strings: `YYYY-MM-DD` for days, `YYYY-MM` for months.

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ACCOUNT_KINDS })
    .notNull()
    .default("checking"),
  offBudget: integer("off_budget", { mode: "boolean" }).notNull().default(false),
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
  // Whether the balance counts as "money available now" in the end-of-month projection.
  inForecast: integer("in_forecast", { mode: "boolean" }).notNull().default(true),
  // Whether the balance counts in the net worth: savings put aside for someone else do not.
  inNetWorth: integer("in_net_worth", { mode: "boolean" }).notNull().default(true),
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
    // A split is a parent row holding the bank amount plus child lines (parent_id set) that carry
    // the categories. Queries pick their side once: `is_parent = 0` keeps the lines (what the
    // budget reads, categories and amounts), `parent_id IS NULL` keeps the bank rows (balances,
    // the register, duplicates and transfers). Both add up to the same total.
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
    index("tx_imported_idx").on(t.importedId).where(sql`imported_id IS NOT NULL`),
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
  conditionsOp: text("conditions_op", { enum: RULE_CONDITIONS_OPS })
    .notNull()
    .default("and"),
  conditions: text("conditions", { mode: "json" }).$type<RuleCondition[]>().notNull(),
  actions: text("actions", { mode: "json" }).$type<RuleAction[]>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  origin: text("origin", { enum: RULE_ORIGINS })
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

export type ValuationSource = typeof ValuationSourceSchema.Type

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: ASSET_TYPES }).notNull(),
  isLiability: integer("is_liability", { mode: "boolean" }).notNull().default(false),
  subtitle: text("subtitle"),
  purchaseAmount: integer("purchase_amount"),
  purchaseDate: text("purchase_date"),
  declaredAmount: integer("declared_amount"),
  declaredDate: text("declared_date"),
  retained: text("retained", { enum: RETAINED_KINDS })
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

/**
 * Market data per CoinGecko coin, shared by every asset holding it. Filled by the daily refresh,
 * so that showing trends and charts never calls CoinGecko.
 */
export const coins = sqliteTable("coins", {
  id: text("id").primaryKey(),
  trendDate: text("trend_date"),
  /** Fractions (0.012 = +1.2 %), in euros. */
  change24h: real("change_24h"),
  change7d: real("change_7d"),
  /** Euro prices over the last 7 days, oldest first, one every 4 hours. */
  sparkline: text("sparkline", { mode: "json" }).$type<number[]>(),
  /** When the yearly daily history was last fetched; null until it has been. */
  historyDate: text("history_date"),
})

/** Daily euro price of a coin: the yearly history, then one price per refresh. */
export const coinPrices = sqliteTable(
  "coin_prices",
  {
    coinId: text("coin_id").notNull(),
    date: text("date").notNull(),
    price: real("price").notNull(),
  },
  (t) => [primaryKey({ columns: [t.coinId, t.date] })],
)

export type InsightViewConfig = typeof InsightQuery.Type

export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }).$type<InsightViewConfig>().notNull(),
  sortOrder: real("sort_order").notNull().default(0),
})

export type DashboardWidget = typeof DashboardWidgetSchema.Type
export type DashboardWidgetKind = DashboardWidget["kind"]

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

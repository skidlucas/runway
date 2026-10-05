import { Schema } from "effect"
import { ACCOUNT_KINDS } from "~/domain/accounts"
import { isDay, isMonth } from "~/domain/dates"
import { INSIGHT_MEASURES, INSIGHT_MONTHS, INSIGHT_ROLLING, INSIGHT_TARGET_KINDS } from "~/domain/insights"
import { RECURRENCE_UNITS } from "~/domain/recurrence"
import { RULE_CONDITION_FIELDS, RULE_CONDITION_OPS, RULE_CONDITIONS_OPS, RULE_ORIGINS } from "~/domain/rules"
import { ASSET_TYPES, PROPERTY_TYPES, RETAINED_KINDS } from "~/domain/wealth"

// Upper bounds on free-form inputs. Import payloads keep their own, unbounded schemas: they
// carry whatever the source app allowed and are already split into chunks by the client.
const text = (max: number) =>
  Schema.String.check(Schema.isMaxLength(max, { message: `Texte trop long (${max} caractères maximum)` }))
const count = (min: number, max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }, { message: `Valeur hors limites (${min} à ${max})` }))

export const Id = text(128)
export const Name = text(200)
export const Notes = text(10_000)
export const SearchText = text(200)
export const Ids = Schema.Array(Id).check(Schema.isMaxLength(100_000, { message: "Trop d'éléments sélectionnés" }))
export const Days = count(0, 366)
export const MonthCount = count(1, 120)
export const Cents = Schema.Int
export const Day = Schema.String.check(Schema.makeFilter((s: string) => isDay(s) || "Date invalide"))
export const Month = Schema.String.check(Schema.makeFilter((s: string) => isMonth(s) || "Mois invalide"))

export const PayeeInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("name"), name: Name }),
  Schema.Struct({ kind: Schema.Literal("id"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("transfer"), accountId: Id }),
  Schema.Struct({ kind: Schema.Literal("none") }),
])

export const Recurrence = Schema.Struct({
  unit: Schema.Literals(RECURRENCE_UNITS),
  interval: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1, { message: "Le rythme doit être d'au moins 1" })),
})

export const RuleCondition = Schema.Struct({
  field: Schema.Literals(RULE_CONDITION_FIELDS),
  op: Schema.Literals(RULE_CONDITION_OPS),
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Tuple([Schema.Finite, Schema.Finite])]),
})

export const RuleAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("set_category"), categoryId: Id }),
  Schema.Struct({ type: Schema.Literal("set_payee"), payeeId: Id }),
  Schema.Struct({ type: Schema.Literal("set_notes"), notes: Schema.String }),
])

export const RulesOp = Schema.Literals(RULE_CONDITIONS_OPS)
export const RuleOrigin = Schema.Literals(RULE_ORIGINS)

export const AccountKind = Schema.Literals(ACCOUNT_KINDS)
export const AssetType = Schema.Literals(ASSET_TYPES)
export const RetainedValue = Schema.Literals(RETAINED_KINDS)

export const ValuationSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  // `label` is the display name picked in the search ("Bitcoin (BTC)", "Lyon 7e Arrondissement").
  Schema.Struct({ kind: Schema.Literal("crypto"), coinId: Schema.String, quantity: Schema.Finite, label: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("stock"), symbol: Schema.String, quantity: Schema.Finite, label: Schema.optional(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("real_estate"),
    inseeCode: Schema.String,
    surface: Schema.Finite,
    propertyType: Schema.Literals(PROPERTY_TYPES),
    label: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("loan"),
    principal: Schema.Int,
    annualRatePct: Schema.Finite,
    months: Schema.Int,
    startDate: Day,
    overrides: Schema.optional(
      Schema.Array(Schema.Struct({ installment: Schema.Int, payment: Schema.Union([Schema.Int, Schema.Literal("interest_only")]) })),
    ),
    insurance: Schema.optional(Schema.Int),
  }),
])

export const InsightQuery = Schema.Struct({
  measure: Schema.Literals(INSIGHT_MEASURES),
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("all") }),
    Schema.Struct({ kind: Schema.Literals(INSIGHT_TARGET_KINDS), id: Schema.String }),
  ]),
  months: Schema.Literals(INSIGHT_MONTHS),
  rolling: Schema.Literals(INSIGHT_ROLLING),
})

export const DashboardWidget = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "net_worth",
    "wealth",
    "cash_flow",
    "spending_comparison",
    "category_spending",
    "account_balances",
    "upcoming",
    "insight_view",
  ]),
  /** Columns taken on the 3-column desktop grid. */
  size: Schema.Literals([1, 2, 3]),
  /** Period of the time-based widgets (net worth, cash flow, category spending). */
  months: Schema.optional(Schema.Int),
  /** Horizon of the `upcoming` widget. */
  days: Schema.optional(Schema.Int),
  /** Saved insights view shown by an `insight_view` widget. */
  viewId: Schema.optional(Schema.String),
})

// --- Imports (Actual files, bank files, runway backups) ----------------------------
// Ids are the source's ids. Months, dates and rhythms the import skips row by row (budgets,
// schedules) are only loosely typed here: one bad row must not reject a whole file.

const NullableString = Schema.NullOr(Schema.String)

export const BundleStructure = Schema.Struct({
  source: Schema.Literals(["actual", "runway"]),
  name: Schema.String,
  accounts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      offBudget: Schema.Boolean,
      closed: Schema.Boolean,
      kind: Schema.optional(Schema.String),
      /** Runway backups only. */
      inForecast: Schema.optional(Schema.Boolean),
      lastReconciledAt: Schema.optional(NullableString),
    }),
  ),
  groups: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, isIncome: Schema.Boolean, hidden: Schema.Boolean, sortOrder: Schema.Finite }),
  ),
  categories: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      groupId: Schema.String,
      name: Schema.String,
      isIncome: Schema.Boolean,
      hidden: Schema.Boolean,
      sortOrder: Schema.Finite,
    }),
  ),
  payees: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, transferAccountId: NullableString })),
  budgets: Schema.Array(Schema.Struct({ month: Schema.String, categoryId: Schema.String, amount: Schema.Int, carryover: Schema.Boolean })),
  buffered: Schema.Array(Schema.Struct({ month: Schema.String, amount: Schema.Int })),
  rules: Schema.Array(
    Schema.Struct({
      conditionsOp: RulesOp,
      conditions: Schema.Array(RuleCondition),
      /** Payee and category ids in actions are source ids. */
      actions: Schema.Array(RuleAction),
      /** Runway backups only; imported rules are enabled otherwise. */
      enabled: Schema.optional(Schema.Boolean),
      /** Runway backups only; marked "imported" otherwise. */
      origin: Schema.optional(RuleOrigin),
    }),
  ),
  schedules: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: NullableString,
      payeeId: NullableString,
      accountId: Schema.String,
      categoryId: NullableString,
      amount: Schema.Int,
      recurrence: Schema.Struct({ unit: Schema.String, interval: Schema.Number }),
      startDate: Schema.String,
      nextDate: Schema.String,
      endDate: NullableString,
      autoPost: Schema.Boolean,
      active: Schema.Boolean,
    }),
  ),
})

/** Runway backups only: wealth, saved insight views and dashboards, restored after the structure. */
export const BundleExtras = Schema.Struct({
  assets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      type: AssetType,
      isLiability: Schema.Boolean,
      subtitle: NullableString,
      purchaseAmount: Schema.NullOr(Schema.Int),
      purchaseDate: Schema.NullOr(Day),
      declaredAmount: Schema.NullOr(Schema.Int),
      declaredDate: Schema.NullOr(Day),
      retained: RetainedValue,
      /** Missing from backups made before shared ownership existed. */
      share: Schema.optional(Schema.Int),
      source: ValuationSource,
      notes: NullableString,
      archived: Schema.Boolean,
      createdAt: Schema.String,
    }),
  ),
  valuations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      assetId: Schema.String,
      date: Day,
      amount: Schema.Int,
      source: Schema.String,
      unitPrice: Schema.NullOr(Schema.Finite),
      asOf: Schema.optional(NullableString),
      automatic: Schema.Boolean,
    }),
  ),
  savedViews: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, config: InsightQuery, sortOrder: Schema.Finite })),
  /** Missing from backups made before dashboards existed. */
  dashboards: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, widgets: Schema.Array(DashboardWidget), sortOrder: Schema.Finite })),
  ),
})

const SourceToNewIds = Schema.Record(Schema.String, Schema.String)

export const IdMaps = Schema.Struct({ accounts: SourceToNewIds, groups: SourceToNewIds, categories: SourceToNewIds, payees: SourceToNewIds })

export const ImportRow = Schema.Struct({
  id: Schema.optional(NullableString),
  accountId: Schema.String,
  date: Day,
  amount: Schema.Int,
  payeeId: Schema.optional(NullableString),
  /** Used by bank files (CSV, OFX, QIF): resolved or created by name on the server. */
  payeeName: Schema.optional(NullableString),
  categoryId: Schema.optional(NullableString),
  notes: Schema.optional(NullableString),
  cleared: Schema.optional(Schema.Boolean),
  reconciled: Schema.optional(Schema.Boolean),
  transferId: Schema.optional(NullableString),
  isParent: Schema.optional(Schema.Boolean),
  parentId: Schema.optional(NullableString),
  importedId: Schema.optional(NullableString),
  importedPayee: Schema.optional(NullableString),
  startingBalance: Schema.optional(Schema.Boolean),
  /** Dropped when no such schedule exists. */
  scheduleId: Schema.optional(NullableString),
  /** Orders the operations of a same day: newest stamp first in the register. */
  createdAt: Schema.optional(NullableString),
})

export const DuplicateProbe = Schema.Struct({
  account: Schema.String,
  date: Day,
  amount: Schema.Int,
  payee: NullableString,
  id: Schema.optional(NullableString),
  importedId: Schema.optional(NullableString),
  importedPayee: Schema.optional(NullableString),
})

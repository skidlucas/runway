import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { RECURRENCE_UNITS } from "~/domain/recurrence"
import { authMiddleware } from "../auth"
import { runApp } from "../runtime"
import { Demo } from "../services/demo"
import { ImportExport } from "../services/import-export"
import { InsightQuery } from "./insights"
import { DashboardWidget } from "./reports"
import { AssetSource } from "./wealth"

const v = Schema.toStandardSchemaV1
const Str = Schema.String
const NStr = Schema.NullOr(Schema.String)
const Opt = <S extends Schema.Top>(s: S) => Schema.optional(s)

export const seedDemo = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(() => runApp(Demo.use((s) => s.seed)))

const RuleCondition = Schema.Struct({
  field: Schema.Literals(["payee", "imported_payee", "notes", "amount", "account"]),
  op: Schema.Literals(["is", "contains", "starts_with", "matches", "gt", "lt", "between"]),
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Tuple([Schema.Finite, Schema.Finite])]),
})
const RuleAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("set_category"), categoryId: Str }),
  Schema.Struct({ type: Schema.Literal("set_payee"), payeeId: Str }),
  Schema.Struct({ type: Schema.Literal("set_notes"), notes: Str }),
])

const Structure = Schema.Struct({
  source: Schema.Literals(["actual", "runway"]),
  name: Str,
  accounts: Schema.Array(Schema.Struct({ id: Str, name: Str, offBudget: Schema.Boolean, closed: Schema.Boolean, kind: Opt(Str) })),
  groups: Schema.Array(Schema.Struct({ id: Str, name: Str, isIncome: Schema.Boolean, hidden: Schema.Boolean, sortOrder: Schema.Finite })),
  categories: Schema.Array(
    Schema.Struct({ id: Str, groupId: Str, name: Str, isIncome: Schema.Boolean, hidden: Schema.Boolean, sortOrder: Schema.Finite }),
  ),
  payees: Schema.Array(Schema.Struct({ id: Str, name: Str, transferAccountId: NStr })),
  budgets: Schema.Array(Schema.Struct({ month: Str, categoryId: Str, amount: Schema.Int, carryover: Schema.Boolean })),
  buffered: Schema.Array(Schema.Struct({ month: Str, amount: Schema.Int })),
  rules: Schema.Array(
    Schema.Struct({ conditionsOp: Schema.Literals(["and", "or"]), conditions: Schema.Array(RuleCondition), actions: Schema.Array(RuleAction) }),
  ),
  schedules: Schema.Array(
    Schema.Struct({
      id: Str,
      name: NStr,
      payeeId: NStr,
      accountId: Str,
      categoryId: NStr,
      amount: Schema.Int,
      recurrence: Schema.Struct({ unit: Schema.Literals(RECURRENCE_UNITS), interval: Schema.Int }),
      startDate: Str,
      nextDate: Str,
      endDate: NStr,
      autoPost: Schema.Boolean,
      active: Schema.Boolean,
    }),
  ),
})

export const importStructure = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        structure: Structure,
        include: Schema.Struct({ budgets: Schema.Boolean, rules: Schema.Boolean, schedules: Schema.Boolean }),
      }),
    ),
  )
  .handler(({ data }) =>
    runApp(
      ImportExport.use((s) =>
        s.importStructure(
          {
            ...data.structure,
            accounts: [...data.structure.accounts],
            groups: [...data.structure.groups],
            categories: [...data.structure.categories],
            payees: [...data.structure.payees],
            budgets: [...data.structure.budgets],
            buffered: [...data.structure.buffered],
            rules: data.structure.rules.map((r) => ({ ...r, conditions: [...r.conditions], actions: [...r.actions] })),
            schedules: [...data.structure.schedules],
          },
          data.include,
        ),
      ),
    ),
  )

const Extras = Schema.Struct({
  assets: Schema.Array(
    Schema.Struct({
      id: Str,
      name: Str,
      type: Schema.Literals(["real_estate", "investment", "crypto", "vehicle", "watch", "art", "cash", "loan", "other"]),
      isLiability: Schema.Boolean,
      subtitle: NStr,
      purchaseAmount: Schema.NullOr(Schema.Int),
      purchaseDate: NStr,
      declaredAmount: Schema.NullOr(Schema.Int),
      declaredDate: NStr,
      retained: Schema.Literals(["purchase", "declared", "estimated"]),
      source: AssetSource,
      notes: NStr,
      archived: Schema.Boolean,
      createdAt: Str,
    }),
  ),
  valuations: Schema.Array(
    Schema.Struct({
      id: Str,
      assetId: Str,
      date: Str,
      amount: Schema.Int,
      source: Str,
      unitPrice: Schema.NullOr(Schema.Finite),
      asOf: Opt(NStr),
      automatic: Schema.Boolean,
    }),
  ),
  savedViews: Schema.Array(Schema.Struct({ id: Str, name: Str, config: InsightQuery, sortOrder: Schema.Finite })),
  dashboards: Opt(Schema.Array(Schema.Struct({ id: Str, name: Str, widgets: Schema.Array(DashboardWidget), sortOrder: Schema.Finite }))),
})
const Ids = Schema.Record(Str, Str)

export const importExtras = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(Schema.Struct({ extras: Extras, maps: Schema.Struct({ accounts: Ids, groups: Ids, categories: Ids, payees: Ids }) })),
  )
  .handler(({ data }) =>
    runApp(
      ImportExport.use((s) =>
        s.importExtras(
          {
            assets: [...data.extras.assets],
            valuations: data.extras.valuations.map((v) => ({ ...v, asOf: v.asOf ?? null })),
            savedViews: [...data.extras.savedViews],
            dashboards: (data.extras.dashboards ?? []).map((d) => ({ ...d, widgets: [...d.widgets] })),
          },
          data.maps,
        ),
      ),
    ),
  )

const ImportRow = Schema.Struct({
  id: Opt(NStr),
  accountId: Str,
  date: Str,
  amount: Schema.Int,
  payeeId: Opt(NStr),
  payeeName: Opt(NStr),
  categoryId: Opt(NStr),
  notes: Opt(NStr),
  cleared: Opt(Schema.Boolean),
  reconciled: Opt(Schema.Boolean),
  transferId: Opt(NStr),
  isParent: Opt(Schema.Boolean),
  parentId: Opt(NStr),
  importedId: Opt(NStr),
  importedPayee: Opt(NStr),
  startingBalance: Opt(Schema.Boolean),
})

export const importTransactions = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        rows: Schema.Array(ImportRow),
        options: Schema.Struct({ dedupe: Schema.Boolean, applyRules: Schema.Boolean }),
      }),
    ),
  )
  .handler(({ data }) => runApp(ImportExport.use((s) => s.importTransactions(data.rows, data.options))))

export const countDuplicates = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        probes: Schema.Array(Schema.Struct({ account: Str, date: Str, amount: Schema.Int, payee: NStr, id: Opt(NStr) })),
      }),
    ),
  )
  .handler(({ data }) => runApp(ImportExport.use((s) => s.countDuplicates(data.probes))))

export const wipeAllData = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(v(Schema.Struct({ confirm: Schema.Literal("SUPPRIMER") })))
  .handler(() => runApp(ImportExport.use((s) => s.wipe)))

export const exportMeta = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runApp(ImportExport.use((s) => s.exportMeta)))

export const exportTransactions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    v(
      Schema.Struct({
        cursor: Schema.NullOr(Schema.Struct({ date: Schema.String, createdAt: Schema.String, id: Schema.String })),
        limit: Schema.Int,
      }),
    ),
  )
  .handler(({ data }) => runApp(ImportExport.use((s) => s.exportTransactions(data.cursor, data.limit))))

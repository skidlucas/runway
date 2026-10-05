import { sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { isDay, isMonth } from "~/domain/dates"
import { FULL_SHARE, isShare } from "~/domain/wealth"
import { normalizeText, type RuleAction, ruleProblem, type RuleSubject } from "~/domain/rules"
import { type BundleExtras, type BundleStructure, type IdMaps, orderStamps } from "~/lib/import-bundle"
import { bulkInsertStatements, chunkRows, Db, type DbError, newId } from "../db/client"
import { readInsightConfig, readRule, readSource, readWidgets } from "../db/json-columns"
import * as schema from "../db/schema"
import { Invalid, type NotFound } from "../errors"
import { AccountKind, DuplicateProbe as DuplicateProbeSchema, ImportRow as ImportRowSchema, Recurrence } from "../schemas"
import { DEFAULT_WIDGETS, MAIN_DASHBOARD_ID, MAIN_DASHBOARD_NAME, MAX_WIDGETS, validWidget } from "./dashboards"
import { Payees } from "./payees"
import { type RuleDto, Rules } from "./rules"
import { Settings } from "./settings"
import { type NewTxRow, transactionInsertStatements } from "./transactions"
import { sourceProblem } from "./wealth"

export type ImportRow = typeof ImportRowSchema.Type

export type ImportOptions = {
  /** Skip rows that match an existing transaction (same account, date, amount and payee). */
  dedupe: boolean
  /** Categorize uncategorized rows with the rules and the payee's usual category. */
  applyRules: boolean
}

/** `skipped`: rows left out because their account does not exist (deleted meanwhile). */
export type ImportResult = { inserted: number; duplicates: number; skipped: number }

export type DuplicateProbe = typeof DuplicateProbeSchema.Type

export type ExportMeta = {
  version: 1
  exportedAt: string
  accounts: Array<typeof schema.accounts.$inferSelect>
  groups: Array<typeof schema.categoryGroups.$inferSelect>
  categories: Array<typeof schema.categories.$inferSelect>
  payees: Array<typeof schema.payees.$inferSelect>
  budgets: Array<typeof schema.budgets.$inferSelect>
  budgetMonths: Array<typeof schema.budgetMonths.$inferSelect>
  rules: Array<typeof schema.rules.$inferSelect>
  schedules: Array<typeof schema.schedules.$inferSelect>
  /** `share` is missing from backups made before shared ownership existed. */
  assets: Array<Omit<typeof schema.assets.$inferSelect, "share"> & { share?: number | undefined }>
  valuations: Array<typeof schema.assetValuations.$inferSelect>
  savedViews: Array<typeof schema.savedViews.$inferSelect>
  /** Missing from backups made before dashboards existed. */
  dashboards?: Array<typeof schema.dashboards.$inferSelect>
  transactionCount: number
}

export type ExportTransaction = typeof schema.transactions.$inferSelect

export type ExportCursor = Pick<ExportTransaction, "date" | "createdAt" | "id">

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const isAccountKind = Schema.is(AccountKind)
const isRecurrence = Schema.is(Recurrence)

type DedupeFields = {
  account: string
  date: string
  amount: number
  payee: string | null
  importedId?: string | null
  importedPayee?: string | null
}

const dedupeKey = (k: DedupeFields) => `${k.account}|${k.date}|${k.amount}|${k.payee ?? ""}`
const labelDedupeKey = (k: DedupeFields, label: string) => `${k.account}|${k.date}|${k.amount}|label:${label.trim()}`

/**
 * Decides which incoming rows already exist, for the import and for its preview alike.
 * A multiset match on (account, date, amount, payee), so two identical coffees on the same day
 * both survive when only one of them was already imported. A row that kept the bank's raw label
 * is matched on that label (a rule may have renamed its payee since), and a known bank id always
 * marks a duplicate. Each call to the returned function consumes the existing row it matched.
 */
const duplicateMatcher = (existing: Iterable<DedupeFields>) => {
  const counts = new Map<string, number>()
  const bankIds = new Set<string>()
  for (const x of existing) {
    const key = x.importedPayee ? labelDedupeKey(x, x.importedPayee) : dedupeKey(x)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (x.importedId) bankIds.add(`${x.account}|${x.importedId}`)
  }
  return (row: DedupeFields) => {
    const byLabel = row.importedPayee ? labelDedupeKey(row, row.importedPayee) : null
    const key = byLabel && counts.get(byLabel) ? byLabel : dedupeKey(row)
    const left = counts.get(key) ?? 0
    if (left > 0) counts.set(key, left - 1)
    return left > 0 || (row.importedId ? bankIds.has(`${row.account}|${row.importedId}`) : false)
  }
}

type Existing = {
  accounts: ReadonlyArray<typeof schema.accounts.$inferSelect>
  groups: ReadonlyArray<typeof schema.categoryGroups.$inferSelect>
  categories: ReadonlyArray<typeof schema.categories.$inferSelect>
  payees: ReadonlyArray<typeof schema.payees.$inferSelect>
  schedules: ReadonlyArray<{ id: string }>
}

type SourceToNewIds = Record<string, string>

const bool = (b: boolean | null | undefined) => (b ? 1 : 0)

/** Keeps a source id unless a row of this budget (or of this import) already uses it. */
const idAllocator = (existing: Existing) => {
  const used = new Set([
    ...existing.accounts.map((a) => a.id),
    ...existing.groups.map((g) => g.id),
    ...existing.categories.map((c) => c.id),
    ...existing.payees.map((p) => p.id),
  ])
  return (sourceId: string) => {
    const id = used.has(sourceId) ? newId() : sourceId
    used.add(id)
    return id
  }
}

/** Accounts: matched by name. */
const planAccounts = (d1: D1Database, structure: BundleStructure, existing: Existing, allocateId: (id: string) => string) => {
  const accountMap: SourceToNewIds = {}
  const accountByName = new Map(existing.accounts.map((a) => [normalizeText(a.name), a.id]))
  const newAccounts: unknown[][] = []
  let order = existing.accounts.length
  for (const a of structure.accounts) {
    const found = accountByName.get(normalizeText(a.name))
    if (found) {
      accountMap[a.id] = found
      continue
    }
    const id = allocateId(a.id)
    accountMap[a.id] = id
    accountByName.set(normalizeText(a.name), id)
    const kind = isAccountKind(a.kind) ? a.kind : a.offBudget ? "savings" : "checking"
    newAccounts.push([id, a.name, kind, bool(a.offBudget), bool(a.closed), bool(a.inForecast ?? !a.offBudget), ++order, a.lastReconciledAt ?? null])
  }
  const writes = bulkInsertStatements(
    d1,
    "accounts",
    ["id", "name", "kind", "off_budget", "closed", "in_forecast", "sort_order", "last_reconciled_at"],
    newAccounts,
  )
  return { accountMap, writes }
}

/** Groups and categories: matched by name (categories within their group first). */
const planCategories = (d1: D1Database, structure: BundleStructure, existing: Existing, allocateId: (id: string) => string) => {
  const groupMap: SourceToNewIds = {}
  const groupByName = new Map(existing.groups.map((g) => [`${g.isIncome}|${normalizeText(g.name)}`, g.id]))
  const newGroups: unknown[][] = []
  for (const g of structure.groups) {
    const key = `${g.isIncome}|${normalizeText(g.name)}`
    const found = groupByName.get(key)
    if (found) {
      groupMap[g.id] = found
      continue
    }
    const id = allocateId(g.id)
    groupMap[g.id] = id
    groupByName.set(key, id)
    newGroups.push([id, g.name, bool(g.isIncome), bool(g.hidden), g.sortOrder + existing.groups.length])
  }

  const categoryMap: SourceToNewIds = {}
  const catKey = (groupId: string, name: string) => `${groupId}|${normalizeText(name)}`
  const catByGroup = new Map(existing.categories.map((c) => [catKey(c.groupId, c.name), c.id]))
  const catByName = new Map(existing.categories.map((c) => [`${c.isIncome}|${normalizeText(c.name)}`, c.id]))
  const newCats: unknown[][] = []
  for (const c of structure.categories) {
    const groupId = groupMap[c.groupId]
    if (!groupId) continue
    const found = catByGroup.get(catKey(groupId, c.name)) ?? catByName.get(`${c.isIncome}|${normalizeText(c.name)}`)
    if (found) {
      categoryMap[c.id] = found
      continue
    }
    const id = allocateId(c.id)
    categoryMap[c.id] = id
    catByGroup.set(catKey(groupId, c.name), id)
    newCats.push([id, groupId, c.name, bool(c.isIncome), bool(c.hidden), c.sortOrder])
  }
  const writes = [
    ...bulkInsertStatements(d1, "category_groups", ["id", "name", "is_income", "hidden", "sort_order"], newGroups),
    ...bulkInsertStatements(d1, "categories", ["id", "group_id", "name", "is_income", "hidden", "sort_order"], newCats),
  ]
  return { groupMap, categoryMap, writes }
}

/** Payees: transfer payees map to the transfer payee of the mapped account, the others match by name. */
const planPayees = (
  d1: D1Database,
  structure: BundleStructure,
  existing: Existing,
  accountMap: SourceToNewIds,
  allocateId: (id: string) => string,
) => {
  const payeeMap: SourceToNewIds = {}
  const transferPayees = new Map(existing.payees.flatMap((p) => (p.transferAccountId ? [[p.transferAccountId, p.id] as const] : [])))
  const accountNames = new Map([...existing.accounts.map((a) => [a.id, a.name] as const), ...structure.accounts.map((a) => [accountMap[a.id]!, a.name] as const)])
  const newTransferPayees: unknown[][] = []
  for (const p of structure.payees) {
    const accountId = p.transferAccountId ? accountMap[p.transferAccountId] : undefined
    if (!accountId) continue
    let id = transferPayees.get(accountId)
    if (!id) {
      id = newId()
      transferPayees.set(accountId, id)
      newTransferPayees.push([id, accountNames.get(accountId) ?? "Virement", accountId])
    }
    payeeMap[p.id] = id
  }
  const payeeByName = new Map(existing.payees.filter((p) => !p.transferAccountId).map((p) => [normalizeText(p.name), p.id]))
  const newPayees: Array<[string, string]> = []
  for (const p of structure.payees) {
    if (p.transferAccountId) continue
    const key = normalizeText(p.name)
    if (key === "") continue
    const found = payeeByName.get(key)
    if (found) {
      payeeMap[p.id] = found
      continue
    }
    const id = allocateId(p.id)
    payeeMap[p.id] = id
    payeeByName.set(key, id)
    newPayees.push([id, p.name.trim()])
  }
  const writes = [
    ...bulkInsertStatements(d1, "payees", ["id", "name", "transfer_account_id"], newTransferPayees),
    ...bulkInsertStatements(d1, "payees", ["id", "name"], newPayees),
  ]
  return { payeeMap, writes }
}

/** Budgeted amounts and buffered income overwrite the same months already there. */
const budgetWrites = (d1: D1Database, structure: BundleStructure, categoryMap: SourceToNewIds): D1PreparedStatement[] => {
  const budgetRows = structure.budgets.flatMap((b) =>
    categoryMap[b.categoryId] && isMonth(b.month) ? [[b.month, categoryMap[b.categoryId]!, b.amount, b.carryover ? 1 : 0]] : [],
  )
  const buffered = structure.buffered.filter((b) => isMonth(b.month)).map((b) => [b.month, b.amount])
  return [
    ...chunkRows(budgetRows).map((chunk) =>
      d1
        .prepare(
          `INSERT INTO budgets (month, category_id, amount, carryover)
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
           FROM json_each(?) WHERE true
           ON CONFLICT(month, category_id) DO UPDATE SET amount = excluded.amount, carryover = excluded.carryover`,
        )
        .bind(JSON.stringify(chunk)),
    ),
    ...chunkRows(buffered).map((chunk) =>
      d1
        .prepare(
          `INSERT INTO budget_months (month, buffered)
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE true
           ON CONFLICT(month) DO UPDATE SET buffered = excluded.buffered`,
        )
        .bind(JSON.stringify(chunk)),
    ),
  ]
}

/** Rules with their ids translated, after the ones already there; an identical rule is not added twice. */
const ruleWrites = (d1: D1Database, structure: BundleStructure, current: ReadonlyArray<RuleDto>, maps: IdMaps): D1PreparedStatement[] => {
  const seen = new Set(current.map((r) => JSON.stringify([r.conditionsOp, r.conditions, r.actions])))
  let sortOrder = current.reduce((max, r) => Math.max(max, r.sortOrder), 0)
  const newRules: unknown[][] = []
  for (const rule of structure.rules) {
    const actions = rule.actions.flatMap((a): RuleAction[] => {
      if (a.type === "set_category") return maps.categories[a.categoryId] ? [{ ...a, categoryId: maps.categories[a.categoryId]! }] : []
      if (a.type === "set_payee") return maps.payees[a.payeeId] ? [{ ...a, payeeId: maps.payees[a.payeeId]! }] : []
      return [a]
    })
    const conditions = rule.conditions.map((c) =>
      c.field === "account" && typeof c.value === "string" ? { ...c, value: maps.accounts[c.value] ?? c.value } : c,
    )
    const key = JSON.stringify([rule.conditionsOp, conditions, actions])
    // A rule Runway cannot run (empty condition, broken regex) is left behind rather than failing the import.
    if (seen.has(key) || ruleProblem({ conditions, actions })) continue
    seen.add(key)
    newRules.push([
      newId(),
      rule.conditionsOp,
      JSON.stringify(conditions),
      JSON.stringify(actions),
      bool(rule.enabled ?? true),
      rule.origin ?? "imported",
      ++sortOrder,
    ])
  }
  return bulkInsertStatements(d1, "rules", ["id", "conditions_op", "conditions", "actions", "enabled", "origin", "sort_order"], newRules)
}

/** Schedules keep their ids; one already there, or with an unreadable rhythm or date, is skipped. */
const scheduleWrites = (d1: D1Database, structure: BundleStructure, existing: Existing, maps: IdMaps): D1PreparedStatement[] => {
  const known = new Set(existing.schedules.map((s) => s.id))
  const newSchedules = structure.schedules.flatMap((s) => {
    const accountId = maps.accounts[s.accountId]
    if (!accountId || known.has(s.id) || !isRecurrence(s.recurrence) || !isDay(s.startDate) || !isDay(s.nextDate)) return []
    known.add(s.id)
    return [
      [
        s.id,
        s.name,
        s.payeeId ? (maps.payees[s.payeeId] ?? null) : null,
        accountId,
        s.categoryId ? (maps.categories[s.categoryId] ?? null) : null,
        s.amount,
        JSON.stringify(s.recurrence),
        s.startDate,
        s.endDate,
        s.nextDate,
        bool(s.autoPost),
        bool(s.active),
      ],
    ]
  })
  return bulkInsertStatements(
    d1,
    "schedules",
    ["id", "name", "payee_id", "account_id", "category_id", "amount", "recurrence", "start_date", "end_date", "next_date", "auto_post", "active"],
    newSchedules,
  )
}

type ResolvedImportRow = Omit<ImportRow, "id" | "payeeId" | "categoryId" | "notes"> & {
  id: string
  payeeId: string | null
  categoryId: string | null
  notes?: string | null | undefined
}

const toNewRows = (rows: ReadonlyArray<ResolvedImportRow>, knownSchedules: ReadonlySet<string>): NewTxRow[] => {
  const fallback = orderStamps(rows.map((_, i) => i))
  return rows.map(
    (r, i): NewTxRow => ({
      id: r.id,
      accountId: r.accountId,
      date: r.date,
      amount: r.amount,
      payeeId: r.payeeId ?? null,
      categoryId: r.isParent ? null : (r.categoryId ?? null),
      notes: r.notes ?? null,
      cleared: r.cleared ?? false,
      reconciled: r.reconciled ?? false,
      transferId: r.transferId ?? null,
      isParent: r.isParent ?? false,
      parentId: r.parentId ?? null,
      importedId: r.importedId ?? null,
      importedPayee: r.importedPayee ?? null,
      startingBalance: r.startingBalance ?? false,
      scheduleId: r.scheduleId && knownSchedules.has(r.scheduleId) ? r.scheduleId : null,
      createdAt: r.createdAt && STAMP.test(r.createdAt) ? r.createdAt : fallback[i]!,
    }),
  )
}

export class ImportExport extends Context.Service<
  ImportExport,
  {
    /** Creates or matches accounts, categories, payees; writes budgets, rules and schedules. */
    importStructure(structure: BundleStructure, include: { budgets: boolean; rules: boolean; schedules: boolean }): Effect.Effect<IdMaps, DbError | Invalid | NotFound>
    importTransactions(rows: ReadonlyArray<ImportRow>, options: ImportOptions): Effect.Effect<ImportResult, DbError | Invalid>
    /** Restores wealth and saved views from a Runway backup, once its structure is imported. */
    importExtras(extras: BundleExtras, maps: IdMaps): Effect.Effect<{ assets: number; views: number }, DbError>
    /** How many of the probes already exist (by id, or by account/date/amount/payee names). */
    countDuplicates(probes: ReadonlyArray<DuplicateProbe>): Effect.Effect<number, DbError>
    /** Deletes every user record: used by "replace all data". */
    readonly wipe: Effect.Effect<void, DbError>
    readonly exportMeta: Effect.Effect<ExportMeta, DbError>
    /** One page in (date, created_at, id) order, after `cursor` (the last row of the previous page). */
    exportTransactions(cursor: ExportCursor | null, limit: number): Effect.Effect<ExportTransaction[], DbError>
  }
>()("runway/server/services/ImportExport") {
  static readonly layer = Layer.effect(
    ImportExport,
    Effect.gen(function* () {
      const db = yield* Db
      const settings = yield* Settings
      const payeesService = yield* Payees
      const rulesService = yield* Rules

      const loadExisting = db
        .use((orm) =>
          orm.batch([
            orm.select().from(schema.accounts),
            orm.select().from(schema.categoryGroups),
            orm.select().from(schema.categories),
            orm.select().from(schema.payees),
            orm.select({ id: schema.schedules.id }).from(schema.schedules),
          ]),
        )
        .pipe(Effect.map(([accounts, groups, categories, payees, schedules]): Existing => ({ accounts, groups, categories, payees, schedules })))

      const importStructure = Effect.fn("ImportExport.importStructure")(function* (
        structure: BundleStructure,
        include: { budgets: boolean; rules: boolean; schedules: boolean },
      ) {
        const existing = yield* loadExisting
        const allocateId = idAllocator(existing)

        // Everything is computed in memory first, then written in one batch: one round trip
        // whatever the number of categories, payees or rules, and nothing half-imported on failure.
        const accounts = planAccounts(db.d1, structure, existing, allocateId)
        const categories = planCategories(db.d1, structure, existing, allocateId)
        const payees = planPayees(db.d1, structure, existing, accounts.accountMap, allocateId)
        const maps: IdMaps = { accounts: accounts.accountMap, groups: categories.groupMap, categories: categories.categoryMap, payees: payees.payeeMap }

        yield* db.batch([
          ...accounts.writes,
          ...categories.writes,
          ...payees.writes,
          ...(include.budgets ? budgetWrites(db.d1, structure, maps.categories) : []),
          ...(include.rules ? ruleWrites(db.d1, structure, yield* rulesService.list, maps) : []),
          ...(include.schedules ? scheduleWrites(db.d1, structure, existing, maps) : []),
        ])

        // Actual's "Starting Balances" becomes the category for new accounts' opening balances.
        const starting = structure.categories.find((c) => c.isIncome && /starting balance|solde(s)? initia/i.test(c.name))
        if (starting && maps.categories[starting.id] && !(yield* settings.get("startingBalanceCategoryId"))) {
          yield* settings.set("startingBalanceCategoryId", maps.categories[starting.id]!)
        }

        return maps
      })

      const idsOf = (r: D1Result | undefined) => new Set(((r?.results ?? []) as Array<{ id: string }>).map((x) => x.id))

      /** Drops references to rows that no longer exist, and finds or creates payees given by name. */
      const resolveReferences = Effect.fn("ImportExport.resolveReferences")(function* (input: ReadonlyArray<ImportRow>) {
        const known = yield* db
          .use((_, d1) =>
            d1.batch([d1.prepare("SELECT id FROM accounts"), d1.prepare("SELECT id FROM categories"), d1.prepare("SELECT id FROM payees")]),
          )
          .pipe(Effect.map(([accs, cats, pays]) => ({ accounts: idsOf(accs), categories: idsOf(cats), payees: idsOf(pays) })))
        const named = input.filter((r) => !r.payeeId && r.payeeName?.trim()).map((r) => r.payeeName!.trim())
        const resolved = named.length ? yield* payeesService.resolveNames(named) : new Map<string, string>()
        const rows = input
          .filter((r) => known.accounts.has(r.accountId))
          .map((r): ResolvedImportRow => ({
            ...r,
            id: r.id ?? newId(),
            payeeId: r.payeeId && known.payees.has(r.payeeId) ? r.payeeId : r.payeeName ? (resolved.get(r.payeeName.trim()) ?? null) : null,
            categoryId: r.categoryId && known.categories.has(r.categoryId) ? r.categoryId : null,
          }))
        return { known, rows }
      })

      /** Rows whose id already exists, then (with `dedupe`) rows `duplicateMatcher` recognizes. */
      const findDuplicates = Effect.fn("ImportExport.findDuplicates")(function* (rows: ReadonlyArray<ResolvedImportRow>, dedupe: boolean) {
        let duplicates = 0
        const skip = new Set<string>()
        const lookups = chunkRows(rows.map((r) => r.id)).map((chunk) =>
          db.d1.prepare("SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(chunk)),
        )
        const found = lookups.length === 0 ? [] : yield* db.use((_, d1) => d1.batch(lookups))
        const existingIds = new Set(found.flatMap((r) => (r.results as Array<{ id: string }>).map((x) => x.id)))
        for (const r of rows) {
          if (existingIds.has(r.id)) {
            skip.add(r.id)
            if (!r.parentId) duplicates++
          }
        }
        const top = dedupe ? rows.filter((r) => !r.parentId && !skip.has(r.id)) : []
        if (top.length > 0) {
          const dates = top.map((r) => r.date).sort()
          const existing = yield* db.use(async (_, d1) => {
            const { results } = await d1
              .prepare(
                `SELECT account_id AS account, date, amount, payee_id AS payee, imported_id AS importedId, imported_payee AS importedPayee
                 FROM transactions
                 WHERE parent_id IS NULL AND date BETWEEN ?1 AND ?2
                   AND account_id IN (SELECT value FROM json_each(?3))
                 UNION ALL
                 -- A line the bank has redated since it was imported keeps its bank id.
                 SELECT account_id, date, amount, payee_id, imported_id, imported_payee FROM transactions
                 WHERE imported_id IN (SELECT value FROM json_each(?4)) AND parent_id IS NULL
                   AND date NOT BETWEEN ?1 AND ?2 AND account_id IN (SELECT value FROM json_each(?3))`,
              )
              .bind(
                dates[0],
                dates[dates.length - 1],
                JSON.stringify([...new Set(top.map((r) => r.accountId))]),
                JSON.stringify(top.flatMap((r) => (r.importedId ? [r.importedId] : []))),
              )
              .all<DedupeFields>()
            return results
          })
          const isDuplicate = duplicateMatcher(existing)
          for (const r of top) {
            if (isDuplicate({ ...r, account: r.accountId, payee: r.payeeId ?? null })) {
              skip.add(r.id)
              duplicates++
            }
          }
        }
        return { skip, duplicates }
      })

      /** The schedules the rows point at that still exist. */
      const existingSchedules = (rows: ReadonlyArray<ResolvedImportRow>) => {
        const scheduleIds = [...new Set(rows.flatMap((r) => (r.scheduleId ? [r.scheduleId] : [])))]
        if (scheduleIds.length === 0) return Effect.succeed(new Set<string>())
        return db
          .use((_, d1) =>
            d1.batch(
              chunkRows(scheduleIds).map((chunk) =>
                d1.prepare("SELECT id FROM schedules WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(chunk)),
              ),
            ),
          )
          .pipe(Effect.map((results) => new Set(results.flatMap((r) => [...idsOf(r)]))))
      }

      /** Categorizes the uncategorized rows in place: rules first, then the payee's usual category. */
      const categorize = Effect.fn("ImportExport.categorize")(function* (
        rows: ReadonlyArray<ResolvedImportRow>,
        known: { categories: ReadonlySet<string>; payees: ReadonlySet<string> },
      ) {
        const match = yield* rulesService.matcher
        const payeesById = yield* db
          .use((_, d1) =>
            d1
              .prepare("SELECT id, name, transfer_account_id AS transferAccountId FROM payees")
              .all<{ id: string; name: string; transferAccountId: string | null }>(),
          )
          .pipe(Effect.map(({ results }) => new Map(results.map((p) => [p.id, p]))))
        const pending: ResolvedImportRow[] = []
        for (const r of rows) {
          if (r.categoryId || r.isParent || r.transferId || (r.payeeId && payeesById.get(r.payeeId)?.transferAccountId)) continue
          const subject: RuleSubject = {
            payeeName: r.payeeId ? (payeesById.get(r.payeeId)?.name ?? null) : null,
            importedPayee: r.importedPayee ?? null,
            notes: r.notes ?? null,
            amount: r.amount,
            accountId: r.accountId,
          }
          const out = match(subject)
          if (out.categoryId && known.categories.has(out.categoryId)) r.categoryId = out.categoryId
          if (out.payeeId && known.payees.has(out.payeeId)) r.payeeId = out.payeeId
          if (out.notes && !r.notes) r.notes = out.notes
          if (!r.categoryId && r.payeeId) pending.push(r)
        }
        const usual = yield* payeesService.suggestCategories(pending.map((r) => r.payeeId!))
        for (const r of pending) r.categoryId = usual.get(r.payeeId!) ?? null
      })

      const importTransactions = Effect.fn("ImportExport.importTransactions")(function* (
        input: ReadonlyArray<ImportRow>,
        options: ImportOptions,
      ) {
        if (input.length === 0) return { inserted: 0, duplicates: 0, skipped: 0 }
        for (const r of input) {
          if (!isDay(r.date) || !Number.isInteger(r.amount)) {
            return yield* new Invalid({ message: `Ligne invalide (${r.date} · ${r.amount})` })
          }
        }
        const { known, rows } = yield* resolveReferences(input)
        const { skip, duplicates } = yield* findDuplicates(rows, options.dedupe)
        const kept = rows.filter((r) => !skip.has(r.id) && !(r.parentId && skip.has(r.parentId)))
        const schedules = yield* existingSchedules(kept)
        if (options.applyRules) yield* categorize(kept, known)
        yield* db.batch(transactionInsertStatements(db.d1, toNewRows(kept, schedules), { mode: "ignore" }))
        const skipped = input.filter((r) => !r.parentId && !known.accounts.has(r.accountId)).length
        return { inserted: kept.filter((r) => !r.parentId).length, duplicates, skipped }
      })

      // Assets and valuations keep their ids and existing ones win, so restoring the same backup
      // twice changes nothing. Views point at categories, groups or payees: their target is
      // translated, and a view whose target was not imported is dropped.
      const importExtras = Effect.fn("ImportExport.importExtras")(function* (input: BundleExtras, maps: IdMaps) {
        // A hand-edited or older backup must not bring an asset the app cannot value (a loan over
        // 0 months makes the whole net worth NaN).
        const extras = { ...input, assets: input.assets.filter((a) => sourceProblem(a.type, a.source) === null) }
        const assetIds = new Set(extras.assets.map((a) => a.id))
        const existingViews = yield* db.use((orm) =>
          orm.select({ name: schema.savedViews.name, sortOrder: schema.savedViews.sortOrder }).from(schema.savedViews),
        )
        const takenNames = new Set(existingViews.map((v) => normalizeText(v.name)))
        let order = existingViews.reduce((max, v) => Math.max(max, v.sortOrder), 0)
        const viewIds = new Map<string, string>()
        const views = extras.savedViews.flatMap((view) => {
          const target = view.config.target
          const targetId =
            target.kind === "all"
              ? null
              : (target.kind === "category" ? maps.categories : target.kind === "group" ? maps.groups : maps.payees)[target.id]
          if ((target.kind !== "all" && !targetId) || takenNames.has(normalizeText(view.name))) return []
          takenNames.add(normalizeText(view.name))
          const config = { ...view.config, target: target.kind === "all" ? target : { kind: target.kind, id: targetId } }
          const id = newId()
          viewIds.set(view.id, id)
          return [[id, view.name, JSON.stringify(config), ++order]]
        })
        const existingDashboards = yield* db.use((orm) => orm.select({ name: schema.dashboards.name }).from(schema.dashboards))
        const dashboardNames = new Set(existingDashboards.map((d) => normalizeText(d.name)))
        const boards = (extras.dashboards ?? []).flatMap((board) => {
          if (dashboardNames.has(normalizeText(board.name))) return []
          dashboardNames.add(normalizeText(board.name))
          // A widget showing a saved view that was not imported would point nowhere.
          const widgets = board.widgets.flatMap((w) => {
            if (!validWidget(w)) return []
            if (w.kind !== "insight_view") return [w]
            const viewId = w.viewId ? viewIds.get(w.viewId) : undefined
            return viewId ? [{ ...w, viewId }] : []
          })
          return [[newId(), board.name, JSON.stringify(widgets.slice(0, MAX_WIDGETS)), board.sortOrder]]
        })
        // Storing a first dashboard would hide the default one, which only exists while none is stored.
        // A backup that holds the default dashboard (maybe renamed) already brings it back.
        const keepMain =
          existingDashboards.length === 0 &&
          boards.length > 0 &&
          !dashboardNames.has(normalizeText(MAIN_DASHBOARD_NAME)) &&
          !(extras.dashboards ?? []).some((b) => b.id === MAIN_DASHBOARD_ID)
        yield* db.batch([
          ...bulkInsertStatements(
            db.d1,
            "assets",
            ["id", "name", "type", "is_liability", "subtitle", "purchase_amount", "purchase_date", "declared_amount", "declared_date", "retained", "share", "source", "notes", "archived", "created_at"],
            extras.assets.map((a) => [
              a.id,
              a.name,
              a.type,
              a.isLiability ? 1 : 0,
              a.subtitle,
              a.purchaseAmount,
              a.purchaseDate,
              a.declaredAmount,
              a.declaredDate,
              a.retained,
              a.share !== undefined && isShare(a.share) ? a.share : FULL_SHARE,
              JSON.stringify(a.source),
              a.notes,
              a.archived ? 1 : 0,
              a.createdAt,
            ]),
            "ignore",
          ),
          ...bulkInsertStatements(
            db.d1,
            "asset_valuations",
            ["id", "asset_id", "date", "amount", "source", "unit_price", "as_of", "automatic"],
            extras.valuations
              .filter((v) => assetIds.has(v.assetId))
              .map((v) => [v.id, v.assetId, v.date, v.amount, v.source, v.unitPrice, v.asOf ?? null, v.automatic ? 1 : 0]),
            "ignore",
          ),
          ...bulkInsertStatements(db.d1, "saved_views", ["id", "name", "config", "sort_order"], views),
          ...bulkInsertStatements(db.d1, "dashboards", ["id", "name", "widgets", "sort_order"], [
            ...(keepMain ? [[MAIN_DASHBOARD_ID, MAIN_DASHBOARD_NAME, JSON.stringify(DEFAULT_WIDGETS), 0]] : []),
            ...boards,
          ]),
        ])
        return { assets: extras.assets.length, views: views.length }
      })

      const countDuplicates = Effect.fn("ImportExport.countDuplicates")(function* (probes: ReadonlyArray<DuplicateProbe>) {
        if (probes.length === 0) return 0
        const dates = probes.map((p) => p.date).sort()
        const probedAccounts = new Set(probes.map((p) => normalizeText(p.account)))
        const accountIds = (yield* db.use((orm) => orm.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts)))
          .filter((a) => probedAccounts.has(normalizeText(a.name)))
          .map((a) => a.id)
        const existing = yield* db.use(async (_, d1) => {
          const { results } = await d1
            .prepare(
              `SELECT t.id, a.name AS account, t.date, t.amount, COALESCE(pa.name, p.name) AS payee,
                 t.imported_id AS importedId, t.imported_payee AS importedPayee
               FROM transactions t JOIN accounts a ON a.id = t.account_id
               LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
               WHERE t.parent_id IS NULL AND t.date BETWEEN ?1 AND ?2 AND t.account_id IN (SELECT value FROM json_each(?3))
               UNION ALL
               SELECT t.id, a.name, t.date, t.amount, COALESCE(pa.name, p.name), t.imported_id, t.imported_payee
               FROM transactions t JOIN accounts a ON a.id = t.account_id
               LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
               WHERE t.imported_id IN (SELECT value FROM json_each(?4)) AND t.parent_id IS NULL
                 AND t.date NOT BETWEEN ?1 AND ?2 AND t.account_id IN (SELECT value FROM json_each(?3))`,
            )
            .bind(
              dates[0],
              dates[dates.length - 1],
              JSON.stringify(accountIds),
              JSON.stringify(probes.flatMap((p) => (p.importedId ? [p.importedId] : []))),
            )
            .all<DedupeFields & { id: string }>()
          return results
        })
        // The preview runs before the file's accounts and payees are matched to ids: it compares
        // names, the way the import will match them.
        const byName = (k: DedupeFields): DedupeFields => ({ ...k, account: normalizeText(k.account), payee: normalizeText(k.payee ?? "") })
        const ids = new Set(existing.map((e) => e.id))
        const isDuplicate = duplicateMatcher(existing.map(byName))
        let n = 0
        for (const p of probes) {
          if ((p.id && ids.has(p.id)) || isDuplicate(byName(p))) n++
        }
        return n
      })

      const wipe = db.batch(
        [
          "DELETE FROM asset_valuations",
          "DELETE FROM assets",
          "DELETE FROM saved_views",
          "DELETE FROM dashboards",
          "DELETE FROM transaction_trash",
          "DELETE FROM ai_cache",
          "DELETE FROM transactions",
          "DELETE FROM schedules",
          "DELETE FROM rules",
          "DELETE FROM budgets",
          "DELETE FROM budget_months",
          "DELETE FROM payees",
          "DELETE FROM categories",
          "DELETE FROM category_groups",
          "DELETE FROM accounts",
          "DELETE FROM settings WHERE key = 'startingBalanceCategoryId'",
        ].map((s) => db.d1.prepare(s)),
      )

      const exportMeta = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const [accounts, groups, categories, payees, budgets, budgetMonths, rules, schedules, assets, valuations, savedViews, dashboards, count] =
          yield* db.use((orm) =>
            orm.batch([
              orm.select().from(schema.accounts),
              orm.select().from(schema.categoryGroups),
              orm.select().from(schema.categories),
              orm.select().from(schema.payees),
              orm.select().from(schema.budgets),
              orm.select().from(schema.budgetMonths),
              orm.select().from(schema.rules).orderBy(schema.rules.sortOrder),
              orm.select().from(schema.schedules),
              orm.select().from(schema.assets),
              orm.select().from(schema.assetValuations),
              orm.select().from(schema.savedViews),
              orm.select().from(schema.dashboards),
              orm.select({ n: sql<number>`COUNT(*)` }).from(schema.transactions),
            ]),
          )
        return {
          version: 1 as const,
          exportedAt: new Date(now).toISOString(),
          accounts,
          groups,
          categories,
          payees,
          budgets,
          budgetMonths,
          rules: rules.map(readRule),
          schedules,
          assets: assets.map((a) => ({ ...a, source: readSource(a.source) })),
          valuations,
          savedViews: savedViews.flatMap((v) => Option.toArray(Option.map(readInsightConfig(v.config), (config) => ({ ...v, config })))),
          dashboards: dashboards.map((d) => ({ ...d, widgets: readWidgets(d.widgets) })),
          transactionCount: count[0]?.n ?? 0,
        } satisfies ExportMeta
      }).pipe(Effect.withSpan("ImportExport.exportMeta"))

      // Keyset pagination on the (date, created_at, id) index: each page is an index seek, where
      // OFFSET re-read every previous row.
      const exportTransactions = (cursor: ExportCursor | null, limit: number) =>
        db.use((orm) => {
          const t = schema.transactions
          return orm
            .select()
            .from(t)
            .where(cursor ? sql`(${t.date}, ${t.createdAt}, ${t.id}) > (${cursor.date}, ${cursor.createdAt}, ${cursor.id})` : undefined)
            .orderBy(t.date, t.createdAt, t.id)
            .limit(Math.min(Math.max(limit, 1), 20_000))
        })

      return ImportExport.of({ importStructure, importTransactions, importExtras, countDuplicates, wipe, exportMeta, exportTransactions })
    }),
  )
}


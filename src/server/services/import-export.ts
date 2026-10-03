import { sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import { isDay, isMonth } from "~/domain/dates"
import { RECURRENCE_UNITS } from "~/domain/recurrence"
import { normalizeText, type RuleAction, type RuleSubject } from "~/domain/rules"
import { type BundleExtras, type BundleStructure, type IdMaps, orderStamps } from "~/lib/import-bundle"
import { bulkInsertStatements, chunkRows, Db, type DbError, newId } from "../db/client"
import * as schema from "../db/schema"
import { Invalid, type NotFound } from "../errors"
import { DEFAULT_WIDGETS, MAIN_DASHBOARD_ID, MAX_WIDGETS, validWidget } from "./dashboards"
import { Payees } from "./payees"
import { ruleInputError, Rules } from "./rules"
import { Settings } from "./settings"
import { sourceProblem } from "./wealth"

export type ImportRow = {
  id?: string | null
  accountId: string
  date: string
  amount: number
  payeeId?: string | null
  /** Used by bank files (CSV, OFX, QIF): resolved or created by name on the server. */
  payeeName?: string | null
  categoryId?: string | null
  notes?: string | null
  cleared?: boolean
  reconciled?: boolean
  transferId?: string | null
  isParent?: boolean
  parentId?: string | null
  importedId?: string | null
  importedPayee?: string | null
  startingBalance?: boolean
  /** Orders the operations of a same day: newest stamp first in the register. */
  createdAt?: string | null
}

export type ImportOptions = {
  /** Skip rows that match an existing transaction (same account, date, amount and payee). */
  dedupe: boolean
  /** Categorize uncategorized rows with the rules and the payee's usual category. */
  applyRules: boolean
}

export type ImportResult = { inserted: number; duplicates: number }

export type DuplicateProbe = { account: string; date: string; amount: number; payee: string | null; id?: string | null }

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
  assets: Array<typeof schema.assets.$inferSelect>
  valuations: Array<typeof schema.assetValuations.$inferSelect>
  savedViews: Array<typeof schema.savedViews.$inferSelect>
  /** Missing from backups made before dashboards existed. */
  dashboards?: Array<typeof schema.dashboards.$inferSelect>
  transactionCount: number
}

export type ExportTransaction = typeof schema.transactions.$inferSelect

export type ExportCursor = Pick<ExportTransaction, "date" | "createdAt" | "id">

const TX_COLUMNS = [
  "id",
  "account_id",
  "date",
  "amount",
  "payee_id",
  "category_id",
  "notes",
  "cleared",
  "reconciled",
  "transfer_id",
  "is_parent",
  "parent_id",
  "imported_id",
  "imported_payee",
  "starting_balance",
  "created_at",
] as const

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const ACCOUNT_KINDS = new Set<string>(["checking", "savings", "credit", "investment", "other"])

const signature = (account: string, date: string, amount: number, payee: string | null) =>
  `${account}|${date}|${amount}|${payee ?? ""}`
const labelSignature = (account: string, date: string, amount: number, label: string) =>
  `${account}|${date}|${amount}|label:${label.trim()}`

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

      const importStructure = Effect.fn("ImportExport.importStructure")(function* (
        structure: BundleStructure,
        include: { budgets: boolean; rules: boolean; schedules: boolean },
      ) {
        const existing = yield* db
          .use((orm) =>
            orm.batch([
              orm.select().from(schema.accounts),
              orm.select().from(schema.categoryGroups),
              orm.select().from(schema.categories),
              orm.select().from(schema.payees),
              orm.select({ id: schema.schedules.id }).from(schema.schedules),
            ]),
          )
          .pipe(Effect.map(([accounts, groups, categories, payees, schedules]) => ({ accounts, groups, categories, payees, schedules })))
        const usedIds = new Set([
          ...existing.accounts.map((a) => a.id),
          ...existing.groups.map((g) => g.id),
          ...existing.categories.map((c) => c.id),
          ...existing.payees.map((p) => p.id),
        ])
        const claim = (id: string) => {
          const chosen = usedIds.has(id) ? newId() : id
          usedIds.add(chosen)
          return chosen
        }

        // Everything is computed in memory first, then written in one batch: one round trip
        // whatever the number of categories, payees or rules, and nothing half-imported on failure.
        const writes: D1PreparedStatement[] = []
        const bool = (b: boolean | null | undefined) => (b ? 1 : 0)

        // Accounts: matched by name.
        const accountMap: Record<string, string> = {}
        const accountByName = new Map(existing.accounts.map((a) => [normalizeText(a.name), a.id]))
        const newAccounts: unknown[][] = []
        let order = existing.accounts.length
        for (const a of structure.accounts) {
          const found = accountByName.get(normalizeText(a.name))
          if (found) {
            accountMap[a.id] = found
            continue
          }
          const id = claim(a.id)
          accountMap[a.id] = id
          accountByName.set(normalizeText(a.name), id)
          const kind = ACCOUNT_KINDS.has(a.kind ?? "") ? a.kind : a.offBudget ? "savings" : "checking"
          newAccounts.push([id, a.name, kind, bool(a.offBudget), bool(a.closed), bool(!a.offBudget), ++order])
        }
        writes.push(
          ...bulkInsertStatements(db.d1, "accounts", ["id", "name", "kind", "off_budget", "closed", "in_forecast", "sort_order"], newAccounts),
        )

        // Groups and categories: matched by name (categories within their group first).
        const groupMap: Record<string, string> = {}
        const groupByName = new Map(existing.groups.map((g) => [`${g.isIncome}|${normalizeText(g.name)}`, g.id]))
        const newGroups: unknown[][] = []
        for (const g of structure.groups) {
          const key = `${g.isIncome}|${normalizeText(g.name)}`
          const found = groupByName.get(key)
          if (found) {
            groupMap[g.id] = found
            continue
          }
          const id = claim(g.id)
          groupMap[g.id] = id
          groupByName.set(key, id)
          newGroups.push([id, g.name, bool(g.isIncome), bool(g.hidden), g.sortOrder + existing.groups.length])
        }
        writes.push(...bulkInsertStatements(db.d1, "category_groups", ["id", "name", "is_income", "hidden", "sort_order"], newGroups))

        const categoryMap: Record<string, string> = {}
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
          const id = claim(c.id)
          categoryMap[c.id] = id
          catByGroup.set(catKey(groupId, c.name), id)
          newCats.push([id, groupId, c.name, bool(c.isIncome), bool(c.hidden), c.sortOrder])
        }
        writes.push(...bulkInsertStatements(db.d1, "categories", ["id", "group_id", "name", "is_income", "hidden", "sort_order"], newCats))

        // Payees: transfer payees map to the transfer payee of the mapped account.
        const payeeMap: Record<string, string> = {}
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
        const payeeByName = new Map(
          existing.payees.filter((p) => !p.transferAccountId).map((p) => [normalizeText(p.name), p.id]),
        )
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
          const id = claim(p.id)
          payeeMap[p.id] = id
          payeeByName.set(key, id)
          newPayees.push([id, p.name.trim()])
        }
        writes.push(
          ...bulkInsertStatements(db.d1, "payees", ["id", "name", "transfer_account_id"], newTransferPayees),
          ...bulkInsertStatements(db.d1, "payees", ["id", "name"], newPayees),
        )

        if (include.budgets) {
          const budgetRows = structure.budgets.flatMap((b) =>
            categoryMap[b.categoryId] && isMonth(b.month) ? [[b.month, categoryMap[b.categoryId]!, b.amount, b.carryover ? 1 : 0]] : [],
          )
          for (const chunk of chunkRows(budgetRows)) {
            writes.push(
              db.d1
                .prepare(
                  `INSERT INTO budgets (month, category_id, amount, carryover)
                   SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
                   FROM json_each(?) WHERE true
                   ON CONFLICT(month, category_id) DO UPDATE SET amount = excluded.amount, carryover = excluded.carryover`,
                )
                .bind(JSON.stringify(chunk)),
            )
          }
          const buffered = structure.buffered.filter((b) => isMonth(b.month)).map((b) => [b.month, b.amount])
          for (const chunk of chunkRows(buffered)) {
            writes.push(
              db.d1
                .prepare(
                  `INSERT INTO budget_months (month, buffered)
                   SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE true
                   ON CONFLICT(month) DO UPDATE SET buffered = excluded.buffered`,
                )
                .bind(JSON.stringify(chunk)),
            )
          }
        }

        if (include.rules) {
          const current = yield* rulesService.list
          const seen = new Set(current.map((r) => JSON.stringify([r.conditionsOp, r.conditions, r.actions])))
          let sortOrder = current.reduce((max, r) => Math.max(max, r.sortOrder), 0)
          const newRules: unknown[][] = []
          for (const rule of structure.rules) {
            const actions = rule.actions.flatMap((a): RuleAction[] => {
              if (a.type === "set_category") return categoryMap[a.categoryId] ? [{ ...a, categoryId: categoryMap[a.categoryId]! }] : []
              if (a.type === "set_payee") return payeeMap[a.payeeId] ? [{ ...a, payeeId: payeeMap[a.payeeId]! }] : []
              return [a]
            })
            const conditions = rule.conditions.map((c) =>
              c.field === "account" && typeof c.value === "string" ? { ...c, value: accountMap[c.value] ?? c.value } : c,
            )
            const key = JSON.stringify([rule.conditionsOp, conditions, actions])
            // A rule Runway cannot run (empty condition, broken regex) is left behind rather than failing the import.
            if (seen.has(key) || ruleInputError({ conditionsOp: rule.conditionsOp, conditions, actions })) continue
            seen.add(key)
            newRules.push([newId(), rule.conditionsOp, JSON.stringify(conditions), JSON.stringify(actions), 1, "imported", ++sortOrder])
          }
          writes.push(
            ...bulkInsertStatements(db.d1, "rules", ["id", "conditions_op", "conditions", "actions", "enabled", "origin", "sort_order"], newRules),
          )
        }

        if (include.schedules) {
          const known = new Set(existing.schedules.map((s) => s.id))
          const newSchedules = structure.schedules.flatMap((s) => {
            const accountId = accountMap[s.accountId]
            const rhythmOk = (RECURRENCE_UNITS as ReadonlyArray<string>).includes(s.recurrence.unit) && Number.isInteger(s.recurrence.interval) && s.recurrence.interval >= 1
            if (!accountId || known.has(s.id) || !rhythmOk || !isDay(s.startDate) || !isDay(s.nextDate)) return []
            known.add(s.id)
            return [
              [
                s.id,
                s.name,
                s.payeeId ? (payeeMap[s.payeeId] ?? null) : null,
                accountId,
                s.categoryId ? (categoryMap[s.categoryId] ?? null) : null,
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
          writes.push(
            ...bulkInsertStatements(
              db.d1,
              "schedules",
              ["id", "name", "payee_id", "account_id", "category_id", "amount", "recurrence", "start_date", "end_date", "next_date", "auto_post", "active"],
              newSchedules,
            ),
          )
        }

        yield* db.batch(writes)

        // Actual's "Starting Balances" becomes the category for new accounts' opening balances.
        const starting = structure.categories.find((c) => c.isIncome && /starting balance|solde(s)? initia/i.test(c.name))
        if (starting && categoryMap[starting.id] && !(yield* settings.get("startingBalanceCategoryId"))) {
          yield* settings.set("startingBalanceCategoryId", categoryMap[starting.id]!)
        }

        return { accounts: accountMap, groups: groupMap, categories: categoryMap, payees: payeeMap }
      })

      const importTransactions = Effect.fn("ImportExport.importTransactions")(function* (
        input: ReadonlyArray<ImportRow>,
        options: ImportOptions,
      ) {
        if (input.length === 0) return { inserted: 0, duplicates: 0 }
        for (const r of input) {
          if (!isDay(r.date) || !Number.isInteger(r.amount)) {
            return yield* new Invalid({ message: `Ligne invalide (${r.date} · ${r.amount})` })
          }
        }
        const ids = (r: D1Result | undefined) => new Set(((r?.results ?? []) as Array<{ id: string }>).map((x) => x.id))
        const known = yield* db
          .use((_, d1) =>
            d1.batch([d1.prepare("SELECT id FROM accounts"), d1.prepare("SELECT id FROM categories"), d1.prepare("SELECT id FROM payees")]),
          )
          .pipe(Effect.map(([accs, cats, pays]) => ({ accounts: ids(accs), categories: ids(cats), payees: ids(pays) })))
        const named = input.filter((r) => !r.payeeId && r.payeeName?.trim()).map((r) => r.payeeName!.trim())
        const resolved = named.length ? yield* payeesService.resolveNames(named) : new Map<string, string>()

        const rows = input
          .filter((r) => known.accounts.has(r.accountId))
          .map((r) => ({
            ...r,
            id: r.id ?? newId(),
            payeeId: r.payeeId && known.payees.has(r.payeeId) ? r.payeeId : r.payeeName ? (resolved.get(r.payeeName.trim()) ?? null) : null,
            categoryId: r.categoryId && known.categories.has(r.categoryId) ? r.categoryId : null,
          }))

        // Duplicates: rows whose id already exists, then a multiset match on
        // (account, date, amount, payee) so two identical coffees on the same day both survive
        // when only one of them was already imported. A row that kept the bank's raw label is
        // matched on that label: a rule may have renamed its payee since.
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
        if (options.dedupe) {
          const top = rows.filter((r) => !r.parentId && !skip.has(r.id))
          if (top.length > 0) {
            const dates = top.map((r) => r.date).sort()
            const counts = yield* db.use(async (_, d1) => {
              const { results } = await d1
                .prepare(
                  `SELECT account_id AS a, date AS d, amount AS m, payee_id AS p, imported_id AS i, imported_payee AS l FROM transactions
                   WHERE parent_id IS NULL AND date BETWEEN ? AND ?
                     AND account_id IN (SELECT value FROM json_each(?))`,
                )
                .bind(dates[0], dates[dates.length - 1], JSON.stringify([...new Set(top.map((r) => r.accountId))]))
                .all<{ a: string; d: string; m: number; p: string | null; i: string | null; l: string | null }>()
              const map = new Map<string, number>()
              const imported = new Set<string>()
              for (const x of results) {
                const key = x.l ? labelSignature(x.a, x.d, x.m, x.l) : signature(x.a, x.d, x.m, x.p)
                map.set(key, (map.get(key) ?? 0) + 1)
                if (x.i) imported.add(`${x.a}|${x.i}`)
              }
              return { map, imported }
            })
            for (const r of top) {
              const byLabel = r.importedPayee ? labelSignature(r.accountId, r.date, r.amount, r.importedPayee) : null
              const key =
                byLabel && counts.map.get(byLabel) ? byLabel : signature(r.accountId, r.date, r.amount, r.payeeId ?? null)
              const left = counts.map.get(key) ?? 0
              const sameBankId = r.importedId ? counts.imported.has(`${r.accountId}|${r.importedId}`) : false
              if (left > 0 || sameBankId) {
                if (left > 0) counts.map.set(key, left - 1)
                skip.add(r.id)
                duplicates++
              }
            }
          }
        }
        const kept = rows.filter((r) => !skip.has(r.id) && !(r.parentId && skip.has(r.parentId)))

        if (options.applyRules) {
          const match = yield* rulesService.matcher
          const names = yield* db
            .use((_, d1) => d1.prepare("SELECT id, name, transfer_account_id AS t FROM payees").all<{ id: string; name: string; t: string | null }>())
            .pipe(Effect.map(({ results }) => new Map(results.map((p) => [p.id, p]))))
          const pending: typeof kept = []
          for (const r of kept) {
            if (r.categoryId || r.isParent || r.transferId || (r.payeeId && names.get(r.payeeId)?.t)) continue
            const subject: RuleSubject = {
              payeeName: r.payeeId ? (names.get(r.payeeId)?.name ?? null) : null,
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
        }

        const fallback = orderStamps(kept.map((_, i) => i))
        const values = kept.map((r, i) => [
          r.id,
          r.accountId,
          r.date,
          r.amount,
          r.payeeId ?? null,
          r.isParent ? null : (r.categoryId ?? null),
          r.notes ?? null,
          r.cleared ? 1 : 0,
          r.reconciled ? 1 : 0,
          r.transferId ?? null,
          r.isParent ? 1 : 0,
          r.parentId ?? null,
          r.importedId ?? null,
          r.importedPayee ?? null,
          r.startingBalance ? 1 : 0,
          r.createdAt && STAMP.test(r.createdAt) ? r.createdAt : fallback[i],
        ])
        yield* db.batch(bulkInsertStatements(db.d1, "transactions", TX_COLUMNS, values, "ignore"))
        return { inserted: kept.filter((r) => !r.parentId).length, duplicates }
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
        const keepMain = existingDashboards.length === 0 && boards.length > 0 && !dashboardNames.has(normalizeText("Principal"))
        yield* db.batch([
          ...bulkInsertStatements(
            db.d1,
            "assets",
            ["id", "name", "type", "is_liability", "subtitle", "purchase_amount", "purchase_date", "declared_amount", "declared_date", "retained", "source", "notes", "archived", "created_at"],
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
            ...(keepMain ? [[MAIN_DASHBOARD_ID, "Principal", JSON.stringify(DEFAULT_WIDGETS), 0]] : []),
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
              `SELECT t.id, a.name AS a, t.date AS d, t.amount AS m, COALESCE(pa.name, p.name) AS p
               FROM transactions t JOIN accounts a ON a.id = t.account_id
               LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN accounts pa ON pa.id = p.transfer_account_id
               WHERE t.parent_id IS NULL AND t.date BETWEEN ? AND ? AND t.account_id IN (SELECT value FROM json_each(?))`,
            )
            .bind(dates[0], dates[dates.length - 1], JSON.stringify(accountIds))
            .all<{ id: string; a: string; d: string; m: number; p: string | null }>()
          return results
        })
        const ids = new Set(existing.map((e) => e.id))
        const counts = new Map<string, number>()
        const key = (a: string, d: string, m: number, p: string | null) => `${normalizeText(a)}|${d}|${m}|${normalizeText(p ?? "")}`
        for (const e of existing) {
          const k = key(e.a, e.d, e.m, e.p)
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
        let n = 0
        for (const p of probes) {
          if (p.id && ids.has(p.id)) {
            n++
            continue
          }
          const k = key(p.account, p.date, p.amount, p.payee)
          const left = counts.get(k) ?? 0
          if (left > 0) {
            counts.set(k, left - 1)
            n++
          }
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
              orm.select().from(schema.rules),
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
          rules,
          schedules,
          assets,
          valuations,
          savedViews,
          dashboards,
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


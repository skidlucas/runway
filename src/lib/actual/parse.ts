import { unzipSync } from "fflate"
import type { Database, SqlJsStatic } from "sql.js"
import { addDays } from "~/domain/dates"
import { nextOnOrAfter, occurrence, periodDays, type Recurrence } from "~/domain/recurrence"
import { patternProblem, type RuleAction, type RuleCondition } from "~/domain/rules"
import { type BundleRule, type BundleSchedule, type BundleTransaction, type ImportBundle, orderStamps } from "../import-bundle"

// Reads an Actual Budget export (zip with db.sqlite + metadata.json).
// Actual stores rows with tombstones, and remaps merged payees/categories through
// payee_mapping / category_mapping: both must be applied to get what Actual shows.

class ActualFormatError extends Error {}

const toDay = (value: unknown): string | null => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 19000101) return null
  const s = String(Math.trunc(n))
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

const toMonth = (value: unknown): string => {
  const s = String(value)
  return s.includes("-") ? s.slice(0, 7) : `${s.slice(0, 4)}-${s.slice(4, 6)}`
}

type Row = Record<string, unknown>

const all = (db: Database, sql: string): Row[] => {
  const stmt = db.prepare(sql)
  const rows: Row[] = []
  while (stmt.step()) rows.push(stmt.getAsObject() as Row)
  stmt.free()
  return rows
}

const hasTable = (db: Database, name: string) =>
  all(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`).length > 0

const columns = (db: Database, table: string) => new Set(all(db, `PRAGMA table_info(${table})`).map((r) => String(r.name)))

export type ActualFile = { db: Uint8Array; metadata: { budgetName?: string; id?: string } }

export const unzipActual = (zip: Uint8Array): ActualFile => {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zip)
  } catch {
    throw new ActualFormatError("Le fichier n'est pas une archive zip valide")
  }
  const dbEntry = Object.keys(files).find((k) => k.endsWith("db.sqlite"))
  if (!dbEntry) throw new ActualFormatError("Pas de db.sqlite dans l'archive : est-ce bien un export Actual ?")
  const metaEntry = Object.keys(files).find((k) => k.endsWith("metadata.json"))
  let metadata = {}
  if (metaEntry) {
    try {
      metadata = JSON.parse(new TextDecoder().decode(files[metaEntry]))
    } catch {}
  }
  return { db: files[dbEntry]!, metadata }
}

export const parseActual = (SQL: SqlJsStatic, file: ActualFile): ImportBundle => {
  const db = new SQL.Database(file.db)
  try {
    return readDatabase(db, file.metadata.budgetName ?? "Actual")
  } finally {
    db.close()
  }
}

// Actual names a schedule created from a future transaction "Auto-created future transaction (Oct 05, 2026) - 1787553522890".
// Without a name, the schedule shows its payee instead.
const AUTO_SCHEDULE_NAME = /^Auto-created future transaction \(/

const readDatabase = (db: Database, name: string): ImportBundle => {
  for (const table of ["accounts", "categories", "category_groups", "transactions", "payees"]) {
    if (!hasTable(db, table)) throw new ActualFormatError(`Table ${table} absente : format Actual non reconnu`)
  }

  const payeeMap = new Map<string, string>()
  if (hasTable(db, "payee_mapping")) {
    for (const r of all(db, "SELECT id, targetId FROM payee_mapping")) payeeMap.set(String(r.id), String(r.targetId))
  }
  const categoryMap = new Map<string, string>()
  if (hasTable(db, "category_mapping")) {
    for (const r of all(db, "SELECT id, transferId FROM category_mapping")) categoryMap.set(String(r.id), String(r.transferId))
  }
  const mapPayee = (id: unknown) => (id == null ? null : (payeeMap.get(String(id)) ?? String(id)))
  const mapCategory = (id: unknown) => (id == null ? null : (categoryMap.get(String(id)) ?? String(id)))

  const accountCols = columns(db, "accounts")
  const accounts = all(
    db,
    `SELECT id, name, offbudget, closed${accountCols.has("sort_order") ? ", sort_order" : ""} FROM accounts WHERE tombstone = 0 ORDER BY ${accountCols.has("sort_order") ? "sort_order, " : ""}name`,
  ).map((r) => ({ id: String(r.id), name: String(r.name ?? "Compte"), offBudget: r.offbudget === 1, closed: r.closed === 1 }))
  const accountIds = new Set(accounts.map((a) => a.id))

  const groupCols = columns(db, "category_groups")
  const groups = all(
    db,
    `SELECT id, name, is_income, sort_order${groupCols.has("hidden") ? ", hidden" : ""} FROM category_groups WHERE tombstone = 0 ORDER BY is_income, sort_order`,
  ).map((r, i) => ({
    id: String(r.id),
    name: String(r.name ?? "Groupe"),
    isIncome: r.is_income === 1,
    hidden: r.hidden === 1,
    sortOrder: i + 1,
  }))
  const groupIds = new Set(groups.map((g) => g.id))

  const catCols = columns(db, "categories")
  const categories = all(
    db,
    `SELECT id, name, is_income, cat_group, sort_order${catCols.has("hidden") ? ", hidden" : ""} FROM categories WHERE tombstone = 0 ORDER BY sort_order`,
  )
    .filter((r) => groupIds.has(String(r.cat_group)))
    .map((r, i) => ({
      id: String(r.id),
      groupId: String(r.cat_group),
      name: String(r.name ?? "Catégorie"),
      isIncome: r.is_income === 1,
      hidden: r.hidden === 1,
      sortOrder: i + 1,
    }))
  const categoryIds = new Set(categories.map((c) => c.id))
  const validCategory = (id: unknown) => {
    const mapped = mapCategory(id)
    return mapped && categoryIds.has(mapped) ? mapped : null
  }

  const payees = all(db, "SELECT id, name, transfer_acct FROM payees WHERE tombstone = 0")
    .filter((r) => r.transfer_acct == null || accountIds.has(String(r.transfer_acct)))
    .map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      transferAccountId: r.transfer_acct == null ? null : String(r.transfer_acct),
    }))
  const payeeIds = new Set(payees.map((p) => p.id))
  const validPayee = (id: unknown) => {
    const mapped = mapPayee(id)
    return mapped && payeeIds.has(mapped) ? mapped : null
  }

  const txCols = columns(db, "transactions")
  const pick = (col: string, fallback = "NULL") => (txCols.has(col) ? col : `${fallback} AS ${col}`)
  const rawTx = all(
    db,
    `SELECT t.id, t.isParent, t.isChild, ${pick("parent_id")}, t.acct, t.category, t.amount, t.description, t.notes, t.date,
            ${pick("cleared", "1")}, ${pick("reconciled", "0")}, t.transferred_id, t.financial_id, t.imported_description,
            t.starting_balance_flag, t.tombstone, ${pick("sort_order")},
            (SELECT p.tombstone FROM transactions p WHERE p.id = t.parent_id) AS parent_tombstone
     FROM transactions t`,
  )
  let skippedTx = 0
  const kept = new Set<string>()
  const transactions: BundleTransaction[] = []
  const sortOrders: number[] = []
  for (const r of rawTx) {
    const date = toDay(r.date)
    const isChild = r.isChild === 1
    if (r.tombstone === 1 || (isChild && r.parent_tombstone !== 0) || !date || r.acct == null) continue
    if (!accountIds.has(String(r.acct))) {
      skippedTx++
      continue
    }
    if (isChild && !r.parent_id) continue
    kept.add(String(r.id))
    transactions.push({
      id: String(r.id),
      accountId: String(r.acct),
      date,
      amount: Number(r.amount ?? 0),
      payeeId: validPayee(r.description),
      categoryId: r.isParent === 1 ? null : validCategory(r.category),
      notes: r.notes == null || r.notes === "" ? null : String(r.notes),
      cleared: r.cleared !== 0,
      reconciled: r.reconciled === 1,
      transferId: r.transferred_id == null ? null : String(r.transferred_id),
      isParent: r.isParent === 1,
      parentId: isChild ? String(r.parent_id) : null,
      importedId: r.financial_id == null ? null : String(r.financial_id),
      importedPayee: r.imported_description == null ? null : String(r.imported_description),
      startingBalance: r.starting_balance_flag === 1,
    })
    sortOrders.push(Number(r.sort_order ?? 0))
  }
  // Actual lists a day's operations by descending sort_order, like runway by creation stamp.
  orderStamps(sortOrders).forEach((stamp, i) => {
    const t = transactions[i]
    if (t) t.createdAt = stamp
  })
  // Drop dangling links (mirror or parent deleted in Actual).
  for (const t of transactions) {
    if (t.transferId && !kept.has(t.transferId)) t.transferId = null
  }
  // Actual lets one line of a split be a transfer; runway rewrites a split's lines on every edit
  // and would orphan the other side. Both sides stay as plain operations, and the other side
  // loses its transfer payee so that editing it does not create a second mirror.
  const byId = new Map(transactions.map((t) => [t.id, t]))
  for (const line of transactions) {
    if (!line.parentId || !line.transferId) continue
    const other = byId.get(line.transferId)
    if (other) {
      other.transferId = null
      other.payeeId = null
    }
    line.transferId = null
  }
  const parents = new Set(transactions.filter((t) => t.isParent).map((t) => t.id))
  const finalTx = transactions.filter((t) => !t.parentId || parents.has(t.parentId))

  // A tracking budget keeps its amounts in reflect_budgets: zero_budgets then only holds what was
  // budgeted before switching, which Actual no longer shows. Runway only has envelopes.
  const tracking =
    hasTable(db, "preferences") && all(db, "SELECT value FROM preferences WHERE id = 'budgetType'")[0]?.value === "tracking"
  // No category_mapping here: deleting a category into another already added its amounts to the
  // other one, and the deleted category's own rows are leftovers.
  const budgetRows = (table: string) =>
    hasTable(db, table)
      ? all(db, `SELECT month, category, amount, carryover FROM ${table}`).filter(
          (r) => categoryIds.has(String(r.category)) && (Number(r.amount ?? 0) !== 0 || r.carryover === 1),
        )
      : []
  const budgets = tracking
    ? []
    : budgetRows("zero_budgets").map((r) => ({
        month: toMonth(r.month),
        categoryId: String(r.category),
        amount: Number(r.amount ?? 0),
        carryover: r.carryover === 1,
      }))
  const buffered =
    !tracking && hasTable(db, "zero_budget_months")
      ? all(db, "SELECT id, buffered FROM zero_budget_months WHERE buffered != 0").map((r) => ({
          month: toMonth(r.id),
          amount: Number(r.buffered),
        }))
      : []

  const payeeName = new Map(payees.map((p) => [p.id, p.name]))
  const { rules, skipped: skippedRules } = readRules(db, mapPayee, mapCategory, payeeName, categoryIds)
  const { schedules, skipped: skippedSchedules, approximated } = readSchedules(db, mapPayee, validCategory, accountIds)

  return {
    source: "actual",
    name,
    accounts,
    groups,
    categories,
    payees,
    transactions: finalTx,
    budgets,
    buffered,
    rules,
    schedules,
    skipped: {
      rules: skippedRules,
      schedules: skippedSchedules,
      transactions: skippedTx,
      budgets: tracking ? budgetRows("reflect_budgets").length : 0,
    },
    approximated: { schedules: approximated },
  }
}

type ActualCondition = { field: string; op: string; value: unknown; options?: unknown }
type ActualAction = { op: string; field?: string; value?: unknown }

const FIELD_ALIASES: Record<string, string> = {
  description: "payee",
  acct: "account",
  imported_description: "imported_payee",
}

const parseJson = <T>(text: unknown): T | null => {
  try {
    return JSON.parse(String(text)) as T
  } catch {
    return null
  }
}

const readRules = (
  db: Database,
  mapPayee: (id: unknown) => string | null,
  mapCategory: (id: unknown) => string | null,
  payeeName: Map<string, string>,
  categoryIds: Set<string>,
): { rules: BundleRule[]; skipped: number } => {
  if (!hasTable(db, "rules")) return { rules: [], skipped: 0 }
  // Rules attached to schedules are internal to Actual's scheduling, not user rules.
  const scheduleRules = hasTable(db, "schedules")
    ? new Set(all(db, "SELECT rule FROM schedules WHERE tombstone = 0").map((r) => String(r.rule)))
    : new Set<string>()
  const rows = all(db, "SELECT id, conditions, actions, conditions_op FROM rules WHERE tombstone = 0")
  const rules: BundleRule[] = []
  let skipped = 0
  for (const row of rows) {
    if (scheduleRules.has(String(row.id))) continue
    const conds = parseJson<ActualCondition[]>(row.conditions) ?? []
    const acts = parseJson<ActualAction[]>(row.actions) ?? []
    let op: "and" | "or" = row.conditions_op === "or" ? "or" : "and"
    const conditions: RuleCondition[] = []
    let ok = true
    for (const c of conds) {
      const field = FIELD_ALIASES[c.field] ?? c.field
      if (field === "payee" && (c.op === "is" || c.op === "oneOf")) {
        const ids = Array.isArray(c.value) ? c.value : [c.value]
        const names = ids.map((id) => payeeName.get(mapPayee(id) ?? "")).filter((n): n is string => !!n)
        if (names.length === 0) {
          ok = false
          break
        }
        if (names.length > 1) {
          if (conds.length > 1) {
            ok = false
            break
          }
          op = "or"
        }
        for (const n of names) conditions.push({ field: "payee", op: "is", value: n })
      } else if ((field === "imported_payee" || field === "notes" || field === "payee") && typeof c.value === "string") {
        const mapped = c.op === "contains" || c.op === "matches" || c.op === "is" ? c.op : null
        if (!mapped || (mapped === "matches" && patternProblem(c.value))) {
          ok = false
          break
        }
        conditions.push({ field: field as RuleCondition["field"], op: mapped, value: c.value })
      } else if (field === "amount") {
        const v = c.value as number | { num1: number; num2: number }
        if (c.op === "isbetween" && typeof v === "object" && v) {
          conditions.push({ field: "amount", op: "between", value: [Math.abs(v.num1), Math.abs(v.num2)] })
        } else if (typeof v === "number" && (c.op === "is" || c.op === "isapprox")) {
          conditions.push({ field: "amount", op: "is", value: Math.abs(v) })
        } else if (typeof v === "number" && (c.op === "gt" || c.op === "gte" || c.op === "lt" || c.op === "lte")) {
          // runway compares the absolute amount: below a negative threshold means spending more
          // than it. Amounts are whole cents, so an inclusive bound moves by one cent.
          const above = (c.op === "gt" || c.op === "gte") === v >= 0
          const inclusive = c.op === "gte" || c.op === "lte"
          const limit = Math.abs(v) + (inclusive ? (above ? -1 : 1) : 0)
          conditions.push({ field: "amount", op: above ? "gt" : "lt", value: limit })
        } else {
          ok = false
          break
        }
      } else if (field === "account" && c.op === "is" && typeof c.value === "string") {
        conditions.push({ field: "account", op: "is", value: c.value })
      } else {
        ok = false
        break
      }
    }
    const actions: RuleAction[] = []
    for (const a of acts) {
      if (a.op !== "set") continue
      if (a.field === "category") {
        const id = mapCategory(a.value)
        if (id && categoryIds.has(id)) actions.push({ type: "set_category", categoryId: id })
      } else if (a.field === "payee" || a.field === "description") {
        const id = mapPayee(a.value)
        if (id && payeeName.has(id)) actions.push({ type: "set_payee", payeeId: id })
      } else if (a.field === "notes" && typeof a.value === "string") {
        actions.push({ type: "set_notes", notes: a.value })
      }
    }
    if (!ok || conditions.length === 0 || actions.length === 0) {
      skipped++
      continue
    }
    rules.push({ conditionsOp: op, conditions, actions })
  }
  return { rules, skipped }
}

const FREQUENCY: Record<string, Recurrence["unit"]> = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }

const readSchedules = (
  db: Database,
  mapPayee: (id: unknown) => string | null,
  validCategory: (id: unknown) => string | null,
  accountIds: Set<string>,
): { schedules: BundleSchedule[]; skipped: number; approximated: number } => {
  if (!hasTable(db, "schedules")) return { schedules: [], skipped: 0, approximated: 0 }
  const rows = all(
    db,
    `SELECT s.id, s.name, s.completed, s.posts_transaction, r.conditions, r.actions,
            CASE WHEN n.local_next_date_ts = n.base_next_date_ts THEN n.local_next_date ELSE n.base_next_date END AS next_date
     FROM schedules s
     LEFT JOIN rules r ON r.id = s.rule
     LEFT JOIN schedules_next_date n ON n.schedule_id = s.id AND n.tombstone = 0
     WHERE s.tombstone = 0`,
  )
  // Actual advances a schedule's stored next date lazily: an occurrence it already posted (or
  // that was matched by hand) can still be the "next" one. Its latest linked transaction tells.
  const lastLinked = new Map(
    columns(db, "transactions").has("schedule")
      ? all(db, "SELECT schedule, MAX(date) AS date FROM transactions WHERE tombstone = 0 AND schedule IS NOT NULL GROUP BY schedule").map(
          (r) => [String(r.schedule), toDay(r.date)] as const,
        )
      : [],
  )
  const schedules: BundleSchedule[] = []
  let skipped = 0
  let approximated = 0
  for (const row of rows) {
    const conds = parseJson<ActualCondition[]>(row.conditions) ?? []
    const acts = parseJson<ActualAction[]>(row.actions) ?? []
    const get = (field: string) => conds.find((c) => c.field === field || FIELD_ALIASES[c.field] === field)
    const account = get("account")?.value
    const amountCond = get("amount")
    const dateCond = get("date")
    const rawAmount = amountCond?.value as number | { num1: number; num2: number } | undefined
    const amount =
      typeof rawAmount === "number" ? rawAmount : rawAmount ? Math.round((rawAmount.num1 + rawAmount.num2) / 2) : null
    const date = dateCond?.value as
      | string
      | {
          start: string
          frequency: string
          interval?: number
          endMode?: string
          endDate?: string
          endOccurrences?: number
          patterns?: unknown[]
          skipWeekend?: boolean
        }
      | undefined
    if (typeof account !== "string" || !accountIds.has(account) || amount === null || !date) {
      skipped++
      continue
    }
    const recurring = typeof date === "object"
    const unit = recurring ? FREQUENCY[date.frequency] : "once"
    if (!unit) {
      skipped++
      continue
    }
    // Runway repeats on the start date's day: "last day of the month", "every 2nd Tuesday" or
    // "move off weekends" are imported on that plain rhythm, for the user to check.
    if (recurring && ((date.patterns?.length ?? 0) > 0 || date.skipWeekend === true)) approximated++
    const startDate = recurring ? date.start : date
    const recurrence: Recurrence = { unit, interval: recurring ? Math.max(1, Number(date.interval ?? 1)) : 1 }
    const endDate = !recurring
      ? null
      : date.endMode === "on_date" && date.endDate
        ? date.endDate
        : date.endMode === "after_n_occurrences" && Number(date.endOccurrences) >= 1
          ? occurrence({ startDate, endDate: null, recurrence }, Number(date.endOccurrences) - 1)
          : null
    const stored = toDay(row.next_date) ?? startDate
    const posted = lastLinked.get(String(row.id))
    // A transaction entered a few days early still covers the occurrence. The margin stays short:
    // further back, the transaction is more likely the late payment of the previous occurrence.
    const covered = posted != null && posted >= addDays(stored, -Math.min(3, Math.floor(periodDays(recurrence) / 4)))
    const following = covered ? nextOnOrAfter({ startDate, endDate, recurrence }, addDays(posted > stored ? posted : stored, 1)) : stored
    const categoryAction = acts.find((a) => a.op === "set" && a.field === "category")
    schedules.push({
      id: String(row.id),
      name: row.name == null || AUTO_SCHEDULE_NAME.test(String(row.name)) ? null : String(row.name),
      payeeId: mapPayee(get("payee")?.value),
      accountId: account,
      categoryId: validCategory(categoryAction?.value),
      amount,
      recurrence,
      startDate,
      nextDate: following ?? stored,
      endDate,
      autoPost: row.posts_transaction === 1,
      active: row.completed !== 1 && following !== null,
    })
  }
  return { schedules, skipped, approximated }
}

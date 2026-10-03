import { strToU8, zipSync } from "fflate"
import type { SqlJsStatic } from "sql.js"
import type { RuleCondition } from "~/domain/rules"
import type { ExportMeta, ExportTransaction } from "~/server/services/import-export"

// Writes Runway data into a copy of an empty Actual database (public/actual-template.sqlite,
// produced by scripts/make-actual-template.mjs) and zips it with metadata.json: the same
// shape as Actual's own "Export" so it can be re-imported with "Import file > Actual".

const toInt = (day: string) => Number(day.replaceAll("-", ""))
const toMonthInt = (month: string) => Number(month.replace("-", ""))

const FREQUENCY = { day: "daily", week: "weekly", month: "monthly", year: "yearly" } as const

export type ActualExportResult = { zip: Uint8Array; skippedRules: number }

export const buildActualExport = (
  SQL: SqlJsStatic,
  template: Uint8Array,
  meta: ExportMeta,
  transactions: ReadonlyArray<ExportTransaction>,
  budgetName = "Runway",
): ActualExportResult => {
  const db = new SQL.Database(template)
  try {
    db.run("BEGIN")
    for (const table of [
      "accounts",
      "payees",
      "payee_mapping",
      "categories",
      "category_groups",
      "category_mapping",
      "transactions",
      "zero_budgets",
      "zero_budget_months",
      "reflect_budgets",
      "rules",
      "schedules",
      "schedules_next_date",
      "schedules_json_paths",
      "messages_crdt",
      "created_budgets",
      "notes",
    ]) {
      db.run(`DELETE FROM ${table}`)
    }

    const insert = (sql: string, rows: ReadonlyArray<ReadonlyArray<unknown>>) => {
      const stmt = db.prepare(sql)
      for (const row of rows) stmt.run(row as never)
      stmt.free()
    }

    insert(
      "INSERT INTO accounts (id, name, offbudget, closed, sort_order, tombstone) VALUES (?, ?, ?, ?, ?, 0)",
      meta.accounts.map((a, i) => [a.id, a.name, a.offBudget ? 1 : 0, a.closed ? 1 : 0, (i + 1) * 16384]),
    )
    insert(
      "INSERT INTO category_groups (id, name, is_income, sort_order, hidden, tombstone) VALUES (?, ?, ?, ?, ?, 0)",
      meta.groups.map((g, i) => [g.id, g.name, g.isIncome ? 1 : 0, (i + 1) * 16384, g.hidden ? 1 : 0]),
    )
    insert(
      "INSERT INTO categories (id, name, is_income, cat_group, sort_order, hidden, tombstone) VALUES (?, ?, ?, ?, ?, ?, 0)",
      meta.categories.map((c, i) => [c.id, c.name, c.isIncome ? 1 : 0, c.groupId, (i + 1) * 16384, c.hidden ? 1 : 0]),
    )
    insert(
      "INSERT INTO category_mapping (id, transferId) VALUES (?, ?)",
      meta.categories.map((c) => [c.id, c.id]),
    )
    // Transfer payees carry no name: Actual displays the account name instead.
    insert(
      "INSERT INTO payees (id, name, transfer_acct, tombstone) VALUES (?, ?, ?, 0)",
      meta.payees.map((p) => [p.id, p.transferAccountId ? "" : p.name, p.transferAccountId]),
    )
    insert(
      "INSERT INTO payee_mapping (id, targetId) VALUES (?, ?)",
      meta.payees.map((p) => [p.id, p.id]),
    )

    insert(
      `INSERT INTO transactions (id, isParent, isChild, parent_id, acct, category, amount, description, notes, date,
         financial_id, imported_description, starting_balance_flag, transferred_id, sort_order, tombstone, cleared, reconciled, schedule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      transactions.map((t, i) => [
        t.id,
        t.isParent ? 1 : 0,
        t.parentId ? 1 : 0,
        t.parentId,
        t.accountId,
        t.isParent ? null : t.categoryId,
        t.amount,
        t.payeeId,
        t.notes,
        toInt(t.date),
        t.importedId,
        t.importedPayee,
        t.startingBalance ? 1 : 0,
        t.transferId,
        i + 1,
        t.cleared ? 1 : 0,
        t.reconciled ? 1 : 0,
        t.scheduleId,
      ]),
    )

    insert(
      "INSERT INTO zero_budgets (id, month, category, amount, carryover) VALUES (?, ?, ?, ?, ?)",
      meta.budgets.map((b) => [`${toMonthInt(b.month)}-${b.categoryId}`, toMonthInt(b.month), b.categoryId, b.amount, b.carryover ? 1 : 0]),
    )
    insert(
      "INSERT INTO zero_budget_months (id, buffered) VALUES (?, ?)",
      meta.budgetMonths.filter((m) => m.buffered).map((m) => [m.month, m.buffered]),
    )

    const payeeByName = new Map(meta.payees.filter((p) => !p.transferAccountId).map((p) => [p.name.toLowerCase(), p.id]))
    let skippedRules = 0
    const ruleRows: unknown[][] = []
    for (const rule of meta.rules) {
      const conditions: Array<{ op: string; field: string; value: unknown; type?: string }> = []
      let ok = true
      for (const c of rule.conditions as RuleCondition[]) {
        if (c.field === "payee" && c.op === "is" && typeof c.value === "string") {
          const id = payeeByName.get(c.value.toLowerCase())
          if (!id) {
            ok = false
            break
          }
          conditions.push({ op: "is", field: "description", value: id, type: "id" })
        } else if ((c.field === "payee" || c.field === "imported_payee" || c.field === "notes") && typeof c.value === "string") {
          const op = c.op === "starts_with" ? "matches" : c.op
          const value = c.op === "starts_with" ? `^${c.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : c.value
          const field = c.field === "imported_payee" ? "imported_description" : c.field === "payee" ? "description" : "notes"
          conditions.push({ op, field, value, type: "string" })
        } else if (c.field === "account" && typeof c.value === "string") {
          conditions.push({ op: "is", field: "acct", value: c.value, type: "id" })
        } else {
          // Runway compares absolute amounts, Actual signed ones: no faithful translation.
          ok = false
          break
        }
      }
      if (!ok) {
        skippedRules++
        continue
      }
      const actions = rule.actions.map((a) =>
        a.type === "set_category"
          ? { op: "set", field: "category", value: a.categoryId, type: "id" }
          : a.type === "set_payee"
            ? { op: "set", field: "description", value: a.payeeId, type: "id" }
            : { op: "set", field: "notes", value: a.notes, type: "string" },
      )
      ruleRows.push([rule.id, null, JSON.stringify(conditions), JSON.stringify(actions), rule.conditionsOp])
    }

    for (const s of meta.schedules) {
      const ruleId = `${s.id}-rule`
      const conditions = [
        { op: "is", field: "description", value: s.payeeId, type: "id" },
        { op: "is", field: "acct", value: s.accountId, type: "id" },
        s.recurrence.unit === "once"
          ? { op: "is", field: "date", type: "date", value: s.startDate }
          : {
              op: "isapprox",
              field: "date",
              type: "date",
              value: {
                start: s.startDate,
                frequency: FREQUENCY[s.recurrence.unit],
                interval: s.recurrence.interval,
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: "after",
                endMode: s.endDate ? "on_date" : "never",
                ...(s.endDate ? { endDate: s.endDate } : {}),
              },
            },
        { op: "isapprox", field: "amount", value: s.amount, type: "number" },
      ]
      const actions: unknown[] = [{ op: "link-schedule", value: s.id }]
      if (s.categoryId) actions.push({ op: "set", field: "category", value: s.categoryId, type: "id" })
      ruleRows.push([ruleId, null, JSON.stringify(conditions), JSON.stringify(actions), "and"])
      insert("INSERT INTO schedules (id, rule, active, completed, posts_transaction, tombstone, name) VALUES (?, ?, 0, ?, ?, 0, ?)", [
        [s.id, ruleId, s.active ? 0 : 1, s.autoPost ? 1 : 0, s.name],
      ])
      const ts = Date.UTC(Number(s.nextDate.slice(0, 4)), Number(s.nextDate.slice(5, 7)) - 1, Number(s.nextDate.slice(8, 10)))
      insert(
        "INSERT INTO schedules_next_date (id, schedule_id, local_next_date, local_next_date_ts, base_next_date, base_next_date_ts, tombstone) VALUES (?, ?, ?, ?, ?, ?, 0)",
        [[`${s.id}-next`, s.id, toInt(s.nextDate), ts, toInt(s.nextDate), ts]],
      )
      insert("INSERT INTO schedules_json_paths (schedule_id, payee, account, amount, date) VALUES (?, '$[0]', '$[1]', '$[3]', '$[2]')", [[s.id]])
    }
    insert("INSERT INTO rules (id, stage, conditions, actions, conditions_op, tombstone) VALUES (?, ?, ?, ?, ?, 0)", ruleRows)
    db.run("COMMIT")

    const bytes = db.export()
    const metadata = {
      id: `Runway-${Math.random().toString(36).slice(2, 9)}`,
      budgetName,
      resetClock: true,
    }
    const zip = zipSync({ "db.sqlite": bytes, "metadata.json": strToU8(JSON.stringify(metadata)) })
    return { zip, skippedRules }
  } finally {
    db.close()
  }
}

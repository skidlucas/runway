import type { ExportMeta, ExportTransaction } from "~/server/services/import-export"
import type { ImportBundle } from "./import-bundle"

export type RunwayBackup = ExportMeta & { format: "runway-backup"; transactions: ExportTransaction[] }

export const isRunwayBackup = (value: unknown): value is RunwayBackup =>
  typeof value === "object" && value !== null && (value as { format?: unknown }).format === "runway-backup"

/** Turns a Runway JSON backup into the generic import bundle. */
export const backupToBundle = (backup: RunwayBackup): ImportBundle => ({
  source: "runway",
  name: "Sauvegarde Runway",
  // Imported accounts and rules are appended in list order.
  accounts: [...backup.accounts]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((a) => ({
      id: a.id,
      name: a.name,
      offBudget: a.offBudget,
      closed: a.closed,
      kind: a.kind,
      inForecast: a.inForecast,
      lastReconciledAt: a.lastReconciledAt,
    })),
  groups: backup.groups.map((g) => ({ id: g.id, name: g.name, isIncome: g.isIncome, hidden: g.hidden, sortOrder: g.sortOrder })),
  categories: backup.categories.map((c) => ({
    id: c.id,
    groupId: c.groupId,
    name: c.name,
    isIncome: c.isIncome,
    hidden: c.hidden,
    sortOrder: c.sortOrder,
  })),
  payees: backup.payees.map((p) => ({ id: p.id, name: p.name, transferAccountId: p.transferAccountId })),
  transactions: backup.transactions.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    date: t.date,
    amount: t.amount,
    payeeId: t.payeeId,
    categoryId: t.categoryId,
    notes: t.notes,
    cleared: t.cleared,
    reconciled: t.reconciled,
    transferId: t.transferId,
    isParent: t.isParent,
    parentId: t.parentId,
    importedId: t.importedId,
    importedPayee: t.importedPayee,
    startingBalance: t.startingBalance,
    scheduleId: t.scheduleId,
    createdAt: t.createdAt,
  })),
  budgets: backup.budgets.map((b) => ({ month: b.month, categoryId: b.categoryId, amount: b.amount, carryover: b.carryover })),
  buffered: backup.budgetMonths.map((m) => ({ month: m.month, amount: m.buffered })),
  rules: [...backup.rules]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({ conditionsOp: r.conditionsOp, conditions: r.conditions, actions: r.actions, enabled: r.enabled, origin: r.origin })),
  schedules: backup.schedules.map((s) => ({
    id: s.id,
    name: s.name,
    payeeId: s.payeeId,
    accountId: s.accountId,
    categoryId: s.categoryId,
    amount: s.amount,
    recurrence: s.recurrence,
    startDate: s.startDate,
    nextDate: s.nextDate,
    endDate: s.endDate,
    autoPost: s.autoPost,
    active: s.active,
  })),
  extras: { assets: backup.assets, valuations: backup.valuations, savedViews: backup.savedViews, dashboards: backup.dashboards ?? [] },
  skipped: { rules: 0, schedules: 0, transactions: 0 },
})

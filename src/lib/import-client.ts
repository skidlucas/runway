import { compareIso } from "~/domain/dates"
import type { DuplicateProbe, ImportOptions, ImportResult, ImportRow } from "~/server/services/import-export"
import { type BundleStructure, type BundleTransaction, fileOrderStamps, type IdMaps, type ImportBundle } from "./import-bundle"
import type { ParsedBankFile } from "./importers/bank"

export type ImportInclude = { transactions: boolean; budgets: boolean; rules: boolean; schedules: boolean }

export type ImportApi = {
  importStructure: (input: { structure: BundleStructure; include: { budgets: boolean; rules: boolean; schedules: boolean } }) => Promise<IdMaps>
  importTransactions: (input: { rows: ImportRow[]; options: ImportOptions }) => Promise<ImportResult>
}

/** Rows per request: keeps each call well under Worker CPU and D1 statement limits. */
const CHUNK_SIZE = 4000

const structureOf = (bundle: ImportBundle): BundleStructure => {
  const { transactions: _t, skipped: _s, approximated: _a, extras: _e, ...structure } = bundle
  return structure
}

/** Translates source ids to the ids chosen by the server. */
const toImportRows = (transactions: ReadonlyArray<BundleTransaction>, maps: IdMaps): ImportRow[] =>
  transactions.flatMap((t) => {
    const accountId = maps.accounts[t.accountId]
    if (!accountId) return []
    return [
      {
        id: t.id,
        accountId,
        date: t.date,
        amount: t.amount,
        payeeId: t.payeeId ? (maps.payees[t.payeeId] ?? null) : null,
        categoryId: t.categoryId ? (maps.categories[t.categoryId] ?? null) : null,
        notes: t.notes,
        cleared: t.cleared,
        reconciled: t.reconciled,
        transferId: t.transferId,
        isParent: t.isParent,
        parentId: t.parentId,
        importedId: t.importedId,
        importedPayee: t.importedPayee,
        startingBalance: t.startingBalance,
        scheduleId: t.scheduleId ?? null,
        createdAt: t.createdAt ?? null,
      },
    ]
  })

/**
 * Splits rows in chunks without separating a split parent from its children,
 * sorted by date so each chunk's duplicate lookup covers a narrow date range.
 * A day is never cut in two: the server matches duplicates on (account, date, amount, payee)
 * against what is already stored, and would otherwise take a row from the previous chunk for
 * a duplicate of an identical one on the same day.
 */
export const chunkFamilies = (rows: ReadonlyArray<ImportRow>, size = CHUNK_SIZE): ImportRow[][] => {
  const children = new Map<string, ImportRow[]>()
  const roots: ImportRow[] = []
  for (const r of rows) {
    if (r.parentId) {
      const list = children.get(r.parentId) ?? []
      list.push(r)
      children.set(r.parentId, list)
    } else roots.push(r)
  }
  roots.sort((a, b) => compareIso(a.date, b.date))
  const chunks: ImportRow[][] = []
  let current: ImportRow[] = []
  let currentDate = ""
  for (const root of roots) {
    const family = [root, ...(root.id ? (children.get(root.id) ?? []) : [])]
    if (current.length > 0 && current.length + family.length > size && root.date !== currentDate) {
      chunks.push(current)
      current = []
    }
    current.push(...family)
    currentDate = root.date
  }
  if (current.length) chunks.push(current)
  return chunks
}

export type ImportProgress = { done: number; total: number; inserted: number; duplicates: number; skipped: number }

/** Sends the rows chunk by chunk, in order, and adds up what the server did with them. */
const importChunks = async (
  rows: ReadonlyArray<ImportRow>,
  options: ImportOptions,
  importTransactions: ImportApi["importTransactions"],
  onProgress: (p: ImportProgress) => void,
): Promise<ImportProgress> => {
  const chunks = chunkFamilies(rows)
  const progress: ImportProgress = { done: 0, total: chunks.reduce((s, c) => s + c.length, 0), inserted: 0, duplicates: 0, skipped: 0 }
  onProgress({ ...progress })
  for (const chunk of chunks) {
    const result = await importTransactions({ rows: chunk, options })
    progress.done += chunk.length
    progress.inserted += result.inserted
    progress.duplicates += result.duplicates
    progress.skipped += result.skipped
    onProgress({ ...progress })
  }
  return progress
}

export const runBundleImport = async (
  bundle: ImportBundle,
  include: ImportInclude,
  api: ImportApi,
  onProgress: (p: ImportProgress) => void = () => {},
) => {
  const maps = await api.importStructure({
    structure: structureOf(bundle),
    include: { budgets: include.budgets, rules: include.rules, schedules: include.schedules },
  })
  if (!include.transactions) return { maps, done: 0, total: 0, inserted: 0, duplicates: 0, skipped: 0 }
  // Rules are not re-applied: the source already categorized its transactions.
  const options = { dedupe: true, applyRules: false }
  const progress = await importChunks(toImportRows(bundle.transactions, maps), options, api.importTransactions, onProgress)
  return { maps, ...progress }
}

/** Imports a bank file into one account, leaving out the operations it already holds. */
export const runBankImport = (
  parsed: ParsedBankFile,
  target: { accountId: string; applyRules: boolean },
  importTransactions: ImportApi["importTransactions"],
  onProgress: (p: ImportProgress) => void = () => {},
) => {
  const stamps = fileOrderStamps(parsed.transactions.map((t) => t.date))
  const rows = parsed.transactions.map((t, i) => ({
    accountId: target.accountId,
    date: t.date,
    amount: t.amount,
    payeeName: t.payee || null,
    importedPayee: t.payee || null,
    notes: t.notes,
    importedId: t.importedId,
    cleared: true,
    createdAt: stamps[i],
  }))
  return importChunks(rows, { dedupe: true, applyRules: target.applyRules }, importTransactions, onProgress)
}

const PROBES_PER_REQUEST = 10_000

/**
 * How many of the bundle's operations already exist, for the preview. Probes go by date, so each
 * request reads a narrow slice of history, and a day is never cut in two, so a duplicate is never
 * counted by two requests. Null once `cancelled` returns true.
 */
export const countBundleDuplicates = async (
  bundle: ImportBundle,
  countDuplicates: (probes: DuplicateProbe[]) => Promise<number>,
  cancelled: () => boolean = () => false,
): Promise<number | null> => {
  const accountName = new Map(bundle.accounts.map((a) => [a.id, a.name]))
  const payeeName = new Map(bundle.payees.map((p) => [p.id, p.transferAccountId ? (accountName.get(p.transferAccountId) ?? p.name) : p.name]))
  const probes = bundle.transactions
    .filter((t) => !t.parentId)
    .map((t) => ({
      account: accountName.get(t.accountId) ?? "",
      date: t.date,
      amount: t.amount,
      payee: t.payeeId ? (payeeName.get(t.payeeId) ?? null) : null,
      id: t.id,
      importedId: t.importedId,
      importedPayee: t.importedPayee,
    }))
    .sort((a, b) => compareIso(a.date, b.date))
  let total = 0
  for (let start = 0; start < probes.length; ) {
    if (cancelled()) return null
    let end = Math.min(start + PROBES_PER_REQUEST, probes.length)
    while (end < probes.length && probes[end]!.date === probes[end - 1]!.date) end++
    total += await countDuplicates(probes.slice(start, end))
    start = end
  }
  return cancelled() ? null : total
}

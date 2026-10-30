import { type InfiniteData, infiniteQueryOptions, type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getAccounts,
  getAgeOfMoney,
  getBudgetMonth,
  getCategories,
  getPayeeNames,
  getPayees,
  getRules,
  getRuleSuggestions,
  listTransactions,
} from "~/server/fns/core"
import { getAiStatus, getFindings, getInsightView, getSavedViews } from "~/server/fns/insights"
import { getCoinHistory, getWealth, getWealthAssets } from "~/server/fns/wealth"
import { getForecast, getScheduledRows, getSchedules, getScheduleSuggestions, getUpcoming } from "~/server/fns/planning"
import { getCashFlow, getCategorySpending, getDashboards, getAccountsTotal, getSpendingComparison } from "~/server/fns/reports"
import type { InsightViewConfig } from "~/server/db/schema"
import type { AccountDto } from "~/server/services/accounts"
import type { BudgetMonthDto, MoveTarget } from "~/server/services/budget"
import type { ScheduledRow } from "~/server/services/schedules"
import type { TxCursor, TxFilter, TxPage, TxRow } from "~/server/services/transactions"
import { toast, toastError } from "~/components/toast"
import type { Month } from "~/domain/dates"
import { withBudgetChanges } from "~/lib/budget-changes"

const TX_PAGE = 200

/** The forecast opens on the first budget account in the user's order, or on every account ("all") when there is none. */
export const defaultForecastAccount = (accounts: ReadonlyArray<AccountDto>) =>
  accounts.find((a) => !a.closed && !a.offBudget)?.id ?? "all"

/** `month` is left out for the current month, so every screen showing it shares one cached forecast. */
export const forecastScope = (account: string, month?: Month) => ({
  ...(account === "all" ? {} : { accountId: account }),
  ...(month ? { month } : {}),
})

export const useCategoryName = (id: string | null | undefined): string | undefined => {
  const categories = useQuery(q.categories())
  return id ? categories.data?.flatMap((g) => g.categories).find((c) => c.id === id)?.name : undefined
}

export const q = {
  accounts: () => queryOptions({ queryKey: ["accounts"], queryFn: () => getAccounts() }),
  categories: () => queryOptions({ queryKey: ["categories"], queryFn: () => getCategories() }),
  /** Payees with their usage counts, which read every transaction. */
  payees: () => queryOptions({ queryKey: ["payees"], queryFn: () => getPayees() }),
  payeeNames: () => queryOptions({ queryKey: ["payeeNames"], queryFn: () => getPayeeNames() }),
  budget: (month: string) =>
    queryOptions({ queryKey: ["budget", month], queryFn: () => getBudgetMonth({ data: { month } }) }),
  ageOfMoney: (month: string) =>
    queryOptions({ queryKey: ["ageOfMoney", month], queryFn: () => getAgeOfMoney({ data: { month } }) }),
  transactions: (filter: Omit<TxFilter, "limit" | "after">) =>
    infiniteQueryOptions({
      queryKey: ["transactions", filter],
      queryFn: ({ pageParam }) => listTransactions({ data: { ...filter, limit: TX_PAGE, ...(pageParam ? { after: pageParam } : {}) } }),
      initialPageParam: null as TxCursor | null,
      getNextPageParam: (last, pages) => {
        const loaded = pages.reduce((n, p) => n + p.rows.length, 0)
        return last.next && loaded < (pages[0]?.total ?? 0) ? last.next : undefined
      },
      placeholderData: (prev) => prev,
    }),
  rules: () => queryOptions({ queryKey: ["rules"], queryFn: () => getRules() }),
  ruleSuggestions: () => queryOptions({ queryKey: ["ruleSuggestions"], queryFn: () => getRuleSuggestions() }),
  forecast: (scope: { month?: string; accountId?: string } = {}) =>
    queryOptions({ queryKey: ["forecast", scope], queryFn: () => getForecast({ data: scope }), placeholderData: (prev) => prev }),
  upcoming: (args: { accountId?: string; days: number }) =>
    queryOptions({ queryKey: ["upcoming", args], queryFn: () => getUpcoming({ data: args }) }),
  scheduledRows: (args: { accountId?: string; days: number }) =>
    queryOptions({ queryKey: ["scheduledRows", args], queryFn: () => getScheduledRows({ data: args }) }),
  schedules: () => queryOptions({ queryKey: ["schedules"], queryFn: () => getSchedules() }),
  scheduleSuggestions: () =>
    queryOptions({ queryKey: ["scheduleSuggestions"], queryFn: () => getScheduleSuggestions() }),
  insightView: (query: InsightViewConfig) =>
    queryOptions({
      queryKey: ["insightView", query],
      queryFn: () => getInsightView({ data: query }),
      placeholderData: (prev) => prev,
    }),
  findings: () => queryOptions({ queryKey: ["findings"], queryFn: () => getFindings() }),
  savedViews: () => queryOptions({ queryKey: ["savedViews"], queryFn: () => getSavedViews() }),
  wealth: () => queryOptions({ queryKey: ["wealth"], queryFn: () => getWealth() }),
  /** The assets of the wealth overview, without the accounts and their history. */
  wealthAssets: () => queryOptions({ queryKey: ["wealthAssets"], queryFn: () => getWealthAssets() }),
  /** A coin's daily prices over the last year and hourly ones over 7 days, from D1: the detail slices them by period. */
  coinHistory: (coinId: string) => queryOptions({ queryKey: ["coinHistory", coinId], queryFn: () => getCoinHistory({ data: { coinId } }) }),
  dashboards: () => queryOptions({ queryKey: ["dashboards"], queryFn: () => getDashboards() }),
  accountsTotal: (months: number) =>
    queryOptions({ queryKey: ["accountsTotal", months], queryFn: () => getAccountsTotal({ data: { months } }) }),
  cashFlow: (months: number) =>
    queryOptions({ queryKey: ["cashFlow", months], queryFn: () => getCashFlow({ data: { months } }) }),
  spendingComparison: () =>
    queryOptions({ queryKey: ["spendingComparison"], queryFn: () => getSpendingComparison() }),
  categorySpending: (months: number) =>
    queryOptions({
      queryKey: ["categorySpending", months],
      queryFn: () => getCategorySpending({ data: { months } }),
    }),
  aiStatus: () => queryOptions({ queryKey: ["aiStatus"], queryFn: () => getAiStatus(), staleTime: Infinity }),
}

type QueryName = keyof typeof q

/**
 * The queries that read each kind of data. An action declares what it writes, and its success
 * refreshes those queries only: the ones on screen are refetched, the others marked stale for
 * their next use. Leaving out a query that reads the data would show it stale.
 */
const READERS = {
  // Operations themselves (amount, date, account, payee, existence): balances, the budget, the
  // forecast, schedule history and every report.
  transactions: [
    "transactions",
    "accounts",
    "payees",
    "payeeNames",
    "budget",
    "ageOfMoney",
    "forecast",
    "upcoming",
    "scheduledRows",
    "schedules",
    "scheduleSuggestions",
    "ruleSuggestions",
    "insightView",
    "findings",
    "wealth",
    "accountsTotal",
    "cashFlow",
    "spendingComparison",
    "categorySpending",
  ],
  // Only the category of operations: no balance moves.
  transactionCategories: [
    "transactions",
    "payees",
    "payeeNames",
    "budget",
    "forecast",
    "upcoming",
    "ruleSuggestions",
    "scheduleSuggestions",
    "insightView",
    "findings",
    "cashFlow",
    "spendingComparison",
    "categorySpending",
  ],
  // Only the cleared flag of operations.
  cleared: ["transactions", "accounts"],
  // Account names, kinds, flags and order: shown or used to filter nearly everywhere.
  accounts: [
    "accounts",
    "transactions",
    "payees",
    "payeeNames",
    "budget",
    "ageOfMoney",
    "forecast",
    "upcoming",
    "scheduledRows",
    "schedules",
    "scheduleSuggestions",
    "insightView",
    "findings",
    "wealth",
    "accountsTotal",
    "cashFlow",
    "spendingComparison",
    "categorySpending",
  ],
  categories: [
    "categories",
    "budget",
    "transactions",
    "schedules",
    "scheduleSuggestions",
    "ruleSuggestions",
    "insightView",
    "findings",
    "cashFlow",
    "spendingComparison",
    "categorySpending",
  ],
  // Payee names, and which payee operations and schedules point at.
  payees: [
    "payees",
    "payeeNames",
    "transactions",
    "schedules",
    "scheduledRows",
    "upcoming",
    "forecast",
    "scheduleSuggestions",
    "ruleSuggestions",
    "insightView",
    "findings",
  ],
  budgets: ["budget", "insightView", "findings"],
  schedules: ["schedules", "scheduledRows", "upcoming", "forecast", "budget", "scheduleSuggestions", "findings"],
  rules: ["rules", "ruleSuggestions"],
  savedViews: ["savedViews"],
  dashboards: ["dashboards"],
  assets: ["wealth", "wealthAssets", "coinHistory"],
  // Imports, demo data, deletions that cascade: everything may have changed.
  everything: Object.keys(q) as QueryName[],
} satisfies Record<string, ReadonlyArray<QueryName>>

export type Written = keyof typeof READERS

/** Refreshes what reads the `written` data (see READERS); resolves once the queries on screen are fresh. */
export const refreshAfter = (client: QueryClient, written: ReadonlyArray<Written>) => {
  const names = new Set(written.flatMap((w): ReadonlyArray<QueryName> => READERS[w]))
  return Promise.all([...names].map((name) => client.invalidateQueries({ queryKey: [name] })))
}

/**
 * Shows an edit on the register rows at once. The refresh that follows the write replaces them with the
 * server's version, which also brings what the patch leaves stale (running balances, order by date).
 */
export const patchTransactionRows = async (client: QueryClient, ids: ReadonlyArray<string>, patch: Partial<TxRow>) => {
  // A fetch already in flight would land after the patch with the rows as they were.
  await client.cancelQueries({ queryKey: ["transactions"] })
  const wanted = new Set(ids)
  const apply = (rows: TxRow[]) => rows.map((row) => (wanted.has(row.id) ? { ...row, ...patch } : row))
  client.setQueriesData<InfiniteData<TxPage>>({ queryKey: ["transactions"] }, (data) =>
    data && {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        rows: apply(page.rows),
        children: Object.fromEntries(Object.entries(page.children).map(([parent, rows]) => [parent, apply(rows)])),
      })),
    },
  )
}

/** Takes deleted operations off the registers at once, with their split lines and transfer mirrors. */
export const removeTransactionRows = async (client: QueryClient, ids: ReadonlyArray<string>) => {
  await client.cancelQueries({ queryKey: ["transactions"] })
  const gone = new Set(ids)
  for (const [, data] of client.getQueriesData<InfiniteData<TxPage>>({ queryKey: ["transactions"] })) {
    for (const page of data?.pages ?? []) for (const row of page.rows) if (gone.has(row.id) && row.transferId) gone.add(row.transferId)
  }
  client.setQueriesData<InfiniteData<TxPage>>({ queryKey: ["transactions"] }, (data) =>
    data && {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        rows: page.rows.filter((row) => !gone.has(row.id)),
        children: Object.fromEntries(Object.entries(page.children).filter(([parent]) => !gone.has(parent))),
      })),
    },
  )
}

/**
 * Takes the occurrence a schedule just booked or skipped off the registers at once; its next one
 * shown there, if any, becomes the one to act on.
 */
export const removeScheduledRow = async (client: QueryClient, scheduleId: string) => {
  await client.cancelQueries({ queryKey: ["scheduledRows"] })
  client.setQueriesData<{ today: string; rows: ScheduledRow[] }>({ queryKey: ["scheduledRows"] }, (data) => {
    if (!data) return data
    const rows = data.rows.filter((row) => !(row.scheduleId === scheduleId && row.next))
    // Newest first: the last remaining row of the schedule is its next occurrence.
    const following = rows.findLastIndex((row) => row.scheduleId === scheduleId)
    return { ...data, rows: rows.map((row, i) => (i === following ? { ...row, next: true } : row)) }
  })
}

/** `patchTransactionRows` for a new category, with its name for the views that show it rather than the picker. */
export const patchTransactionCategory = (client: QueryClient, ids: ReadonlyArray<string>, categoryId: string | null) => {
  const groups = client.getQueryData(q.categories().queryKey)
  const categoryName = (categoryId && groups?.flatMap((g) => g.categories).find((c) => c.id === categoryId)?.name) || null
  return patchTransactionRows(client, ids, { categoryId, categoryName })
}

/** `patchTransactionRows` for an existing payee, named from the list the payee picker loaded. */
export const patchTransactionPayee = (client: QueryClient, id: string, payeeId: string) => {
  const payeeName = client.getQueryData(q.payeeNames().queryKey)?.find((p) => p.id === payeeId)?.name ?? null
  return patchTransactionRows(client, [id], { payeeId, payeeName })
}

const patchBudget = async (client: QueryClient, month: string, changesOf: (budget: BudgetMonthDto) => ReadonlyMap<string, number>) => {
  const { queryKey } = q.budget(month)
  await client.cancelQueries({ queryKey })
  client.setQueryData(queryKey, (budget) => budget && withBudgetChanges(budget, changesOf(budget)))
}

/** Shows a category's new budget, and the totals that follow, at once; the refresh brings the months after it. */
export const patchBudgetAmount = (client: QueryClient, edit: { month: string; categoryId: string; amount: number }) =>
  patchBudget(client, edit.month, (budget) => {
    const current = budget.groups.flatMap((g) => g.categories).find((c) => c.id === edit.categoryId)?.budgeted ?? 0
    return new Map([[edit.categoryId, edit.amount - current]])
  })

/** `patchBudgetAmount` for money moved between categories, or to and from what is left to budget. */
export const patchBudgetMove = (client: QueryClient, move: { month: string; from: MoveTarget; to: MoveTarget; amount: number }) =>
  patchBudget(client, move.month, () => {
    const changes = new Map<string, number>()
    if (move.from.kind === "category") changes.set(move.from.id, -move.amount)
    if (move.to.kind === "category") changes.set(move.to.id, (changes.get(move.to.id) ?? 0) + move.amount)
    return changes
  })

/** Wraps a server function call in a mutation; a success refreshes what reads the data it `writes`. */
export function useAction<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  options: {
    success?: string | ((output: TOutput) => string | undefined)
    onSuccess?: (output: TOutput) => void
    writes: ReadonlyArray<Written>
    /** Calls sharing a scope run one after the other, in the order they were made. */
    scope?: string
    /** Shows the expected result before the server answers; a failure refreshes `writes` to undo it. */
    optimistic?: (input: TInput, client: QueryClient) => void | Promise<void>
    /**
     * False runs `onSuccess` as soon as the server answered, and the views on screen catch up a moment
     * later: for a form used several times in a row, which should neither wait nor stay pending.
     */
    awaitRefresh?: boolean
  },
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    scope: options.scope ? { id: options.scope } : undefined,
    mutationKey: options.scope ? [options.scope] : undefined,
    onMutate: options.optimistic && ((input) => options.optimistic?.(input, client)),
    onSuccess: async (output) => {
      const message = typeof options.success === "function" ? options.success(output) : options.success
      if (message) toast(message)
      // A refresh now would read the database before the next call of the scope is written, and take
      // its patch back off the screen until that call's own refresh: that one brings both.
      if (options.optimistic && options.scope && client.isMutating({ mutationKey: [options.scope] }) > 1) {
        options.onSuccess?.(output)
        return
      }
      // Callers close or navigate in `onSuccess`: wait for fresh data so the next view never shows the old one.
      if (options.awaitRefresh === false) void refreshAfter(client, options.writes)
      else await refreshAfter(client, options.writes)
      options.onSuccess?.(output)
    },
    onError: (error) => {
      toastError(error)
      if (options.optimistic) void refreshAfter(client, options.writes)
    },
  })
}

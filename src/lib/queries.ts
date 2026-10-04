import { infiniteQueryOptions, type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query"
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
import { getWealth, getWealthAssets } from "~/server/fns/wealth"
import { getForecast, getScheduledRows, getSchedules, getScheduleSuggestions, getUpcoming } from "~/server/fns/planning"
import { getCashFlow, getCategorySpending, getDashboards, getNetWorth, getSpendingComparison } from "~/server/fns/reports"
import type { InsightViewConfig } from "~/server/db/schema"
import type { AccountDto } from "~/server/services/accounts"
import type { TxCursor, TxFilter } from "~/server/services/transactions"
import { toast, toastError } from "~/components/toast"
import { leaveIfSignedOut } from "~/lib/auth"

export const TX_PAGE = 200

/** The forecast opens on the first budget account in the user's order, or on every account ("all") when there is none. */
export const defaultForecastAccount = (accounts: ReadonlyArray<AccountDto>) =>
  accounts.find((a) => !a.closed && !a.offBudget)?.id ?? "all"

export const forecastScope = (account: string) => (account === "all" ? {} : { accountId: account })

/** Reports only change with a write, and every write refreshes them: refocusing the tab need not refetch. */
const REPORT_STALE = 5 * 60_000

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
  dashboards: () => queryOptions({ queryKey: ["dashboards"], queryFn: () => getDashboards() }),
  netWorth: (months: number) =>
    queryOptions({ queryKey: ["netWorth", months], queryFn: () => getNetWorth({ data: { months } }), staleTime: REPORT_STALE }),
  cashFlow: (months: number) =>
    queryOptions({ queryKey: ["cashFlow", months], queryFn: () => getCashFlow({ data: { months } }), staleTime: REPORT_STALE }),
  spendingComparison: () =>
    queryOptions({ queryKey: ["spendingComparison"], queryFn: () => getSpendingComparison(), staleTime: REPORT_STALE }),
  categorySpending: (months: number) =>
    queryOptions({
      queryKey: ["categorySpending", months],
      queryFn: () => getCategorySpending({ data: { months } }),
      staleTime: REPORT_STALE,
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
    "netWorth",
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
    "netWorth",
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
  assets: ["wealth", "wealthAssets"],
  // Imports, demo data, deletions that cascade: everything may have changed.
  everything: Object.keys(q) as QueryName[],
} satisfies Record<string, ReadonlyArray<QueryName>>

export type Written = keyof typeof READERS

/** Refreshes what reads the `written` data (see READERS); resolves once the queries on screen are fresh. */
export const refreshAfter = (client: QueryClient, written: ReadonlyArray<Written>) => {
  const names = new Set(written.flatMap((w): ReadonlyArray<QueryName> => READERS[w]))
  return Promise.all([...names].map((name) => client.invalidateQueries({ queryKey: [name] })))
}

/** Wraps a server function call in a mutation; a success refreshes what reads the data it `writes`. */
export function useAction<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  options: {
    success?: string | ((output: TOutput) => string | undefined)
    onSuccess?: (output: TOutput) => void
    writes: ReadonlyArray<Written>
    /** Calls sharing a scope run one after the other, in the order they were made. */
    scope?: string
  },
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    scope: options.scope ? { id: options.scope } : undefined,
    onSuccess: async (output) => {
      const message = typeof options.success === "function" ? options.success(output) : options.success
      if (message) toast(message)
      // Callers close or navigate in `onSuccess`: wait for fresh data so the next view never shows the old one.
      await refreshAfter(client, options.writes)
      options.onSuccess?.(output)
    },
    onError: (error) => {
      if (!leaveIfSignedOut(error)) toastError(error)
    },
  })
}

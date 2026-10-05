import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Lock, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import * as React from "react"
import { EditAccountDialog, ReconcileDialog } from "~/components/account-dialogs"
import { SuggestButton, SuggestionsBar, SuggestionsProvider, useCategorySuggestions } from "~/components/category-suggestions"
import { AccountSummary, MobileAccountSummary } from "~/components/register/account-summary"
import { BulkBar } from "~/components/register/bulk-bar"
import { isFiltered, NO_SCHEDULED, type RegisterSearch, scheduledFilterOf, txFilterOf } from "~/components/register/filter"
import { MobileList } from "~/components/register/mobile-list"
import { TransactionTable } from "~/components/register/transaction-table"
import { PageHeader, useAppUi } from "~/components/shell"
import { Button, EmptyState, IconButton, Menu, RemovableChip, SearchInput, SkeletonRows, useConfirm } from "~/components/ui"
import { formatMonthLong } from "~/domain/dates"
import { count } from "~/domain/text"
import { shortcutBlocked, useDebounced, useIsMobile } from "~/lib/hooks"
import { q, useAction, useCategoryName } from "~/lib/queries"
import { deleteAccount, setAccountClosed } from "~/server/fns/core"
import type { TxPage } from "~/server/services/transactions"

export const Route = createFileRoute("/_app/accounts/$accountId")({
  validateSearch: (s: Record<string, unknown>): RegisterSearch => ({
    ...(typeof s.categoryId === "string" ? { categoryId: s.categoryId } : {}),
    ...(typeof s.month === "string" ? { month: s.month } : {}),
    ...(s.uncategorized ? { uncategorized: true } : {}),
    ...(typeof s.q === "string" ? { q: s.q } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => {
    const all = params.accountId === "all"
    const filtered = isFiltered(deps) || deps.q?.trim()
    return Promise.all([
      context.queryClient.ensureQueryData(q.categories()),
      // Loaded with the operations so that the schedule lines do not push the list down afterwards.
      filtered ? null : context.queryClient.prefetchQuery(q.scheduledRows(scheduledFilterOf(params.accountId))),
      all ? null : context.queryClient.prefetchQuery(q.forecast({ accountId: params.accountId })),
      context.queryClient.ensureInfiniteQueryData(q.transactions(txFilterOf(params.accountId, deps))),
    ])
  },
  // Remounting per account drops the search text, the selection and the previous account's rows.
  component: function AccountRoute() {
    const { accountId } = Route.useParams()
    return <AccountPage key={accountId} accountId={accountId} />
  },
})

function AccountPage({ accountId }: { accountId: string }) {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: "/accounts/$accountId" })
  const all = accountId === "all"
  const accounts = useQuery(q.accounts())
  const account = accounts.data?.find((a) => a.id === accountId)
  const [text, setText] = React.useState(search.q ?? "")
  const debounced = useDebounced(text, 250)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [dialog, setDialog] = React.useState<null | "edit-account" | "reconcile">(null)
  const mobile = useIsMobile()
  const searchRef = React.useRef<HTMLInputElement>(null)
  const { openNewTransaction } = useAppUi()

  const txs = useInfiniteQuery(q.transactions(txFilterOf(accountId, { ...search, q: debounced })))
  const pages = txs.data?.pages
  const rows = React.useMemo(() => pages?.flatMap((p) => p.rows) ?? [], [pages])
  const childrenByParent = React.useMemo(() => Object.assign({}, ...(pages ?? []).map((p) => p.children)) as TxPage["children"], [pages])
  const total = pages?.[0]?.total ?? 0
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = txs
  const loadMore = React.useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  React.useEffect(() => {
    setSelected(new Set())
  }, [search.categoryId, search.month, search.uncategorized, debounced])

  // Deleted or filtered-out rows leave the selection.
  React.useEffect(() => {
    const visible = new Set(rows.map((r) => r.id))
    setSelected((prev) => {
      const kept = new Set([...prev].filter((id) => visible.has(id)))
      return kept.size === prev.size ? prev : kept
    })
  }, [rows])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !shortcutBlocked(e)) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const { confirm, dialog: confirmDialog } = useConfirm()
  const closeAccount = useAction(setAccountClosed, { success: "Compte mis à jour", writes: ["accounts"] })
  const removeAccount = useAction(deleteAccount, {
    success: "Compte supprimé",
    writes: ["everything"],
    onSuccess: () => void navigate({ to: "/accounts" }),
  })

  const categoryName = useCategoryName(search.categoryId)
  const title = all ? "Toutes les opérations" : (account?.name ?? "Compte")
  const hasFilters = isFiltered(search)
  // Schedules due soon read as forecast lines among the operations, unless the list is filtered.
  const showScheduled = !hasFilters && !debounced.trim()
  const scheduledQuery = useQuery({ ...q.scheduledRows(scheduledFilterOf(accountId)), enabled: showScheduled })
  const scheduled = showScheduled ? (scheduledQuery.data?.rows ?? NO_SCHEDULED) : NO_SCHEDULED
  const suggestions = useCategorySuggestions(rows)

  return (
    <>
      <PageHeader
        title="Comptes"
        crumb={title}
        right={
          <>
            {mobile && account ? <MobileAccountSummary account={account} /> : null}
            <Button
              variant="primary"
              icon={<Plus size={14} />}
              onClick={() => openNewTransaction(all ? {} : { accountId })}
              className="max-md:hidden"
            >
              Opération
            </Button>
            {account ? (
              <>
                <Button onClick={() => setDialog("reconcile")} className="max-md:hidden">
                  Rapprocher
                </Button>
                <Menu
                  trigger={
                    <IconButton label="Actions du compte">
                      <MoreHorizontal size={15} />
                    </IconButton>
                  }
                  items={[
                    { label: "Modifier le compte", icon: <Pencil size={13} />, onSelect: () => setDialog("edit-account") },
                    { label: "Rapprocher", icon: <Lock size={13} />, onSelect: () => setDialog("reconcile") },
                    {
                      label: account.closed ? "Rouvrir le compte" : "Clôturer le compte",
                      onSelect: () => closeAccount.mutate({ data: { id: account.id, closed: !account.closed } }),
                    },
                    { separator: true },
                    {
                      label: "Supprimer le compte",
                      danger: true,
                      icon: <Trash2 size={13} />,
                      onSelect: async () => {
                        const ok = await confirm({
                          title: `Supprimer « ${account.name} »${account.transactionCount === 1 ? " et son opération" : account.transactionCount > 1 ? ` et ses ${count(account.transactionCount, "opération")}` : ""} ?`,
                        })
                        if (ok) removeAccount.mutate({ data: { id: account.id } })
                      },
                    },
                  ]}
                />
              </>
            ) : null}
          </>
        }
      />
      {account && !mobile ? <AccountSummary account={account} /> : null}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2 max-md:border-none max-md:pt-3">
        <SearchInput
          ref={searchRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Rechercher"
          aria-label="Rechercher une opération"
          shortcut={mobile ? undefined : "/"}
          wrapperClassName="w-[280px] max-md:w-full"
          className="max-md:h-9 max-md:border-none max-md:bg-subtle"
        />
        {search.categoryId ? (
          <FilterChip label={`Catégorie : ${categoryName ?? "…"}`} onClear={() => void navigate({ search: { ...search, categoryId: undefined } })} />
        ) : null}
        {search.month ? (
          <FilterChip label={formatMonthLong(search.month)} onClear={() => void navigate({ search: { ...search, month: undefined } })} />
        ) : null}
        {search.uncategorized ? (
          <FilterChip label="À catégoriser" onClear={() => void navigate({ search: { ...search, uncategorized: undefined } })} />
        ) : null}
        <SuggestButton s={suggestions} />
        {txs.data ? <span className="ml-auto text-[12px] text-faint max-md:hidden">{count(total, "opération")}</span> : null}
      </div>
      {selected.size > 0 ? (
        <BulkBar ids={[...selected]} rows={rows} onDone={() => setSelected(new Set())} />
      ) : (
        <SuggestionsBar s={suggestions} />
      )}
      <SuggestionsProvider s={suggestions}>
      {!txs.data ? (
        <SkeletonRows rows={14} />
      ) : rows.length === 0 && scheduled.length === 0 ? (
        <EmptyState
          title={hasFilters || debounced ? "Aucune opération ne correspond." : "Aucune opération sur ce compte."}
          action={
            <Button variant="primary" onClick={() => openNewTransaction(all ? {} : { accountId })}>
              Ajouter
            </Button>
          }
        />
      ) : mobile ? (
        <MobileList rows={rows} scheduled={scheduled} childrenByParent={childrenByParent} onReachEnd={loadMore} />
      ) : (
        <TransactionTable
          rows={rows}
          scheduled={scheduled}
          childrenByParent={childrenByParent}
          showAccount={all}
          showBalance={rows[0]?.balance !== null}
          selected={selected}
          setSelected={setSelected}
          accountId={all ? undefined : accountId}
          onReachEnd={loadMore}
        />
      )}
      </SuggestionsProvider>
      {txs.hasNextPage ? (
        <div className="flex justify-center py-4">
          <Button variant="ghost" onClick={loadMore} loading={isFetchingNextPage}>
            Afficher plus ({count(total - rows.length, "restante")})
          </Button>
        </div>
      ) : null}
      {dialog === "edit-account" && account ? <EditAccountDialog account={account} onClose={() => setDialog(null)} /> : null}
      {dialog === "reconcile" && account ? <ReconcileDialog account={account} onClose={() => setDialog(null)} /> : null}
      {confirmDialog}
    </>
  )
}

const FilterChip = ({ label, onClear }: { label: string; onClear: () => void }) => (
  <RemovableChip removeLabel={`Retirer le filtre ${label}`} onRemove={onClear}>
    {label}
  </RemovableChip>
)

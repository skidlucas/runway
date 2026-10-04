import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useWindowVirtualizer, type VirtualItem } from "@tanstack/react-virtual"
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  SkipForward,
  Split,
  Trash2,
  Wand2,
} from "lucide-react"
import * as React from "react"
import { EditAccountDialog, ReconcileDialog } from "~/components/account-dialogs"
import { CategoryPicker, PayeePicker } from "~/components/pickers"
import {
  SuggestButton,
  SuggestionChip,
  SuggestionsBar,
  SuggestionsProvider,
  useCategorySuggestions,
} from "~/components/category-suggestions"
import { ScheduleDialog } from "~/components/schedule-dialog"
import { PageHeader, useAppUi } from "~/components/shell"
import {
  RuleFromTransactionDialog,
  TransactionEditor,
  payeeInputOf,
  payeeValueOf,
  useDeleteTransactions,
} from "~/components/transaction-editor"
import { Button, Calendar, Checkbox, Chip, cx, DateInput, Dialog, EmptyState, IconButton, heroAmountClass, InlineEdit, Kpi, Menu, Money, Popover, RemovableChip, revealOnHover, SearchInput, SkeletonRows, useConfirm } from "~/components/ui"
import { type Day, formatDayLong, formatDayShort, formatMonthLong, monthOf, parseDayInput } from "~/domain/dates"
import { amountInput, formatMoney, parseAmount } from "~/domain/money"
import { shortcutBlocked, useDebounced, useIsMobile, useToday } from "~/lib/hooks"
import { q, useAction } from "~/lib/queries"
import {
  createTransaction,
  deleteAccount,
  setAccountClosed,
  setTransactionsCategory,
  setTransactionsCleared,
  updateTransaction,
} from "~/server/fns/core"
import { postSchedule, skipSchedule } from "~/server/fns/planning"
import type { AccountDto } from "~/server/services/accounts"
import type { ScheduledRow } from "~/server/services/schedules"
import type { TxPage, TxRow } from "~/server/services/transactions"
import { count } from "~/domain/text"

type Search = { categoryId?: string; month?: string; uncategorized?: boolean; q?: string }

export const Route = createFileRoute("/_app/accounts/$accountId")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.categoryId === "string" ? { categoryId: s.categoryId } : {}),
    ...(typeof s.month === "string" ? { month: s.month } : {}),
    ...(s.uncategorized ? { uncategorized: true } : {}),
    ...(typeof s.q === "string" ? { q: s.q } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => {
    const all = params.accountId === "all"
    const filtered = deps.categoryId || deps.month || deps.uncategorized || deps.q?.trim()
    return Promise.all([
      context.queryClient.ensureQueryData(q.categories()),
      // Loaded with the operations so that the schedule lines do not push the list down afterwards.
      filtered ? null : context.queryClient.prefetchQuery(q.scheduledRows({ ...(all ? {} : { accountId: params.accountId }), days: DAYS_AHEAD })),
      all ? null : context.queryClient.prefetchQuery(q.forecast({ accountId: params.accountId })),
      context.queryClient.ensureInfiniteQueryData(
        q.transactions({
          ...(params.accountId === "all" ? {} : { accountId: params.accountId }),
          ...(deps.categoryId ? { categoryId: deps.categoryId } : {}),
          ...(deps.month ? { month: deps.month } : {}),
          ...(deps.uncategorized ? { uncategorized: true } : {}),
          ...(deps.q?.trim() ? { search: deps.q.trim() } : {}),
        }),
      ),
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
  const categories = useQuery(q.categories())
  const account = accounts.data?.find((a) => a.id === accountId)
  const [text, setText] = React.useState(search.q ?? "")
  const debounced = useDebounced(text, 250)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [dialog, setDialog] = React.useState<null | "edit-account" | "reconcile">(null)
  const mobile = useIsMobile()
  const searchRef = React.useRef<HTMLInputElement>(null)
  const { openNewTransaction } = useAppUi()

  const filter = {
    ...(all ? {} : { accountId }),
    ...(search.categoryId ? { categoryId: search.categoryId } : {}),
    ...(search.month ? { month: search.month } : {}),
    ...(search.uncategorized ? { uncategorized: true } : {}),
    ...(debounced.trim() ? { search: debounced.trim() } : {}),
  }
  const txs = useInfiniteQuery(q.transactions(filter))
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
  const closeAccount = useAction(setAccountClosed, { success: "Compte mis à jour" })
  const removeAccount = useAction(deleteAccount, {
    success: "Compte supprimé",
    onSuccess: () => void navigate({ to: "/accounts" }),
  })

  const categoryName = categories.data?.flatMap((g) => g.categories).find((c) => c.id === search.categoryId)?.name
  const title = all ? "Toutes les opérations" : (account?.name ?? "Compte")
  const hasFilters = search.categoryId || search.month || search.uncategorized
  // Schedules due soon read as forecast lines among the operations, unless the list is filtered.
  const showScheduled = !hasFilters && !debounced.trim()
  const scheduledQuery = useQuery({ ...q.scheduledRows({ ...(all ? {} : { accountId }), days: DAYS_AHEAD }), enabled: showScheduled })
  const scheduled = showScheduled ? (scheduledQuery.data?.rows ?? NO_SCHEDULED) : NO_SCHEDULED
  const suggestions = useCategorySuggestions(rows)

  return (
    <>
      <PageHeader
        title="Comptes"
        crumb={title}
        right={
          <>
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
      {account ? mobile ? <MobileAccountSummary account={account} /> : <AccountSummary account={account} /> : null}
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

// --- Balances ----------------------------------------------------

const DAYS_AHEAD = 7
const NO_SCHEDULED: ScheduledRow[] = []

function AccountSummary({ account }: { account: AccountDto }) {
  const forecast = useQuery(q.forecast({ accountId: account.id }))
  const booked = account.balance - account.balanceToday
  const f = forecast.data?.accountId === account.id ? forecast.data : undefined
  return (
    <div className="border-b border-line">
      <div className="grid grid-cols-3 gap-4 px-5 py-4">
        <Kpi label="Aujourd'hui" value={formatMoney(account.balanceToday)} size="lg" valueClassName={account.balanceToday < 0 ? "text-negative" : undefined} />
        <Kpi
          label="Avec les opérations à venir"
          value={formatMoney(account.balance)}
          size="lg"
          valueClassName={cx(booked === 0 && "text-muted", account.balance < 0 && "text-negative")}
          hint={booked === 0 ? "Pas d'écart avec aujourd'hui" : `${formatMoney(booked, { sign: "always" })} déjà saisis`}
        />
        <Kpi
          label={f ? `Prévu au ${formatDayShort(f.days.at(-1)?.date ?? f.today)}` : "Fin de mois"}
          value={f ? formatMoney(f.projectedEndBalance) : "…"}
          size="lg"
          valueClassName={f && f.projectedEndBalance < 0 ? "text-negative" : "text-accent-fg"}
          hint={
            account.offBudget ? (
              "Échéances comprises"
            ) : (
              <Link to="/forecast" search={{ account: account.id }} className="hover:text-fg">
                Échéances comprises · détail
              </Link>
            )
          }
        />
      </div>
    </div>
  )
}

function MobileAccountSummary({ account }: { account: AccountDto }) {
  const forecast = useQuery(q.forecast({ accountId: account.id }))
  const f = forecast.data?.accountId === account.id ? forecast.data : undefined
  return (
    <div className="flex flex-col gap-1 border-b border-line px-5 pb-4">
      <Money value={account.balanceToday} className={heroAmountClass} />
      <span className="text-[12px] text-muted">
        {account.balance !== account.balanceToday ? `${formatMoney(account.balance)} avec les opérations à venir` : "Aujourd'hui"}
        {f ? ` · ${formatMoney(f.projectedEndBalance)} prévus en fin de mois` : ""}
      </span>
    </div>
  )
}

function BulkBar({ ids, rows, onDone }: { ids: string[]; rows: TxRow[]; onDone: () => void }) {
  const setCategory = useAction(setTransactionsCategory, { success: "Catégorie appliquée", onSuccess: onDone })
  const setCleared = useAction(setTransactionsCleared, { onSuccess: onDone })
  const remove = useDeleteTransactions(onDone)
  const chosen = new Set(ids)
  const allCleared = rows.filter((r) => chosen.has(r.id)).every((r) => r.cleared)
  return (
    <div className="sticky top-12 z-20 flex items-center gap-2 border-b border-line bg-accent-soft px-5 py-2">
      <span className="font-medium">{count(ids.length, "sélectionnée")}</span>
      <CategoryPicker
        value={null}
        onChange={(categoryId) => setCategory.mutate({ data: { ids, categoryId } })}
        placeholder="Catégoriser…"
        className="w-[200px]"
      />
      <Button size="sm" onClick={() => setCleared.mutate({ data: { ids, cleared: !allCleared } })}>
        {allCleared ? "Dépointer" : "Pointer"}
      </Button>
      <Button
        size="sm"
        variant="danger"
        icon={<Trash2 size={13} />}
        onClick={() => remove.mutate(ids)}
      >
        Supprimer
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone} className="ml-auto">
        Annuler
      </Button>
    </div>
  )
}

// --- Window-scrolled virtual lists ------------------------------------------------

const PREFETCH_ROWS = 40

/**
 * Renders only the rows near the viewport: the page scrolls as a whole (sticky header and
 * sidebar), so the list follows the window and its offset from the top of the page.
 */
function useWindowList(options: {
  count: number
  estimateSize: (index: number) => number
  getItemKey: (index: number) => string
  onReachEnd?: () => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = React.useState(0)
  const measure = React.useCallback(() => {
    const el = ref.current
    if (el) setScrollMargin(Math.round(el.getBoundingClientRect().top + window.scrollY))
  }, [])
  // Whatever sits above the list (bulk bar, balances loading) moves it down and grows the page.
  React.useLayoutEffect(measure, [measure])
  React.useEffect(() => {
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    return () => observer.disconnect()
  }, [measure])
  const virtualizer = useWindowVirtualizer({
    count: options.count,
    estimateSize: options.estimateSize,
    getItemKey: options.getItemKey,
    overscan: 10,
    scrollMargin,
    initialRect: { width: 0, height: 900 },
  })
  const items = virtualizer.getVirtualItems()
  const last = items.at(-1)?.index ?? -1
  const { count, onReachEnd } = options
  React.useEffect(() => {
    if (count > 0 && last >= count - PREFETCH_ROWS) onReachEnd?.()
  }, [last, count, onReachEnd])
  return { ref, virtualizer, items, offset: (item: VirtualItem) => item.start - scrollMargin }
}

/** Each schedule line goes above the operations of its day; both lists are newest first. */
function interleave<T>(rows: TxRow[], scheduled: ScheduledRow[], ofTx: (tx: TxRow) => T[], ofScheduled: (row: ScheduledRow) => T): T[] {
  const out: T[] = []
  let i = 0
  for (const tx of rows) {
    while (i < scheduled.length && scheduled[i]!.date >= tx.date) out.push(ofScheduled(scheduled[i++]!))
    out.push(...ofTx(tx))
  }
  while (i < scheduled.length) out.push(ofScheduled(scheduled[i++]!))
  return out
}

const scheduledKey = (row: ScheduledRow) => `schedule:${row.scheduleId}:${row.dueDate}`

function useScheduledRow(row: ScheduledRow) {
  const post = useAction(postSchedule, { success: "Opération enregistrée" })
  const skip = useAction(skipSchedule, { success: "Échéance passée" })
  const categories = useQuery(q.categories())
  const accounts = useQuery(q.accounts())
  const category = row.categoryId ? categories.data?.flatMap((g) => g.categories).find((c) => c.id === row.categoryId)?.name : undefined
  return {
    busy: post.isPending || skip.isPending,
    // A future occurrence is booked on its own day, an overdue one on its due day.
    post: () => post.mutate({ data: { id: row.scheduleId, ...(row.overdue ? {} : { date: row.date }) } }),
    skip: () => skip.mutate({ data: { id: row.scheduleId } }),
    category: category ?? (row.transferAccountId ? "Virement" : "Hors budget"),
    account: accounts.data?.find((a) => a.id === row.accountId)?.name ?? "",
    date: row.overdue ? "en retard" : formatDayShort(row.date),
  }
}

// --- Desktop table -----------------------------------------------------------------

type Line = { kind: "tx"; tx: TxRow } | { kind: "split"; tx: TxRow } | { kind: "scheduled"; row: ScheduledRow }

function TransactionTable({
  rows,
  scheduled,
  childrenByParent,
  showAccount,
  showBalance,
  selected,
  setSelected,
  accountId,
  onReachEnd,
}: {
  rows: TxRow[]
  scheduled: ScheduledRow[]
  childrenByParent: Record<string, TxRow[]>
  showAccount: boolean
  showBalance: boolean
  selected: Set<string>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  accountId: string | undefined
  onReachEnd: () => void
}) {
  const columns = cx(
    "grid items-center gap-3",
    showAccount
      ? "grid-cols-[20px_88px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_120px_24px_28px]"
      : showBalance
        ? "grid-cols-[20px_88px_minmax(0,1.3fr)_minmax(0,1fr)_120px_120px_24px_28px]"
        : "grid-cols-[20px_88px_minmax(0,1.3fr)_minmax(0,1fr)_120px_24px_28px]",
  )
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const today = useToday()
  const onSelect = React.useCallback(
    (id: string, checked: boolean) =>
      setSelected((s) => {
        const next = new Set(s)
        if (checked) next.add(id)
        else next.delete(id)
        return next
      }),
    [setSelected],
  )
  const onToggleExpand = React.useCallback(
    (id: string) =>
      setExpanded((s) => {
        const next = new Set(s)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    [],
  )
  const lines = React.useMemo(
    () =>
      interleave<Line>(
        rows,
        scheduled,
        (tx) =>
          tx.isParent && expanded.has(tx.id)
            ? [{ kind: "tx", tx }, ...(childrenByParent[tx.id] ?? []).map((child): Line => ({ kind: "split", tx: child }))]
            : [{ kind: "tx", tx }],
        (row) => ({ kind: "scheduled", row }),
      ),
    [rows, scheduled, expanded, childrenByParent],
  )
  const list = useWindowList({
    count: lines.length,
    estimateSize: (i) => (lines[i]?.kind === "split" ? 32 : 36),
    getItemKey: (i) => {
      const line = lines[i]
      return !line ? String(i) : line.kind === "scheduled" ? scheduledKey(line.row) : line.tx.id
    },
    onReachEnd,
  })
  return (
    <div role="table" aria-label="Opérations" aria-rowcount={lines.length + 1}>
      <div role="row" aria-rowindex={1} className={cx(columns, "h-[34px] border-b border-line px-5 text-[12px] text-faint")}>
        <Checkbox
          checked={allSelected}
          label="Tout sélectionner"
          onCheckedChange={(c) => setSelected(c ? new Set(rows.map((r) => r.id)) : new Set())}
        />
        <span>Date</span>
        <span>Bénéficiaire</span>
        <span>Catégorie</span>
        {showAccount ? <span>Compte</span> : null}
        <span className="text-right">Montant</span>
        {showBalance && !showAccount ? <span className="text-right">Solde</span> : null}
        <span />
        <span />
      </div>
      <div ref={list.ref} role="rowgroup" className="relative" style={{ height: list.virtualizer.getTotalSize() }}>
        {list.items.map((item) => {
          const line = lines[item.index]
          if (!line) return null
          const top = list.offset(item)
          // Only the rows near the viewport are in the page: the header is row 1.
          const rowIndex = item.index + 2
          if (line.kind === "scheduled") {
            return (
              <ScheduledLine
                key={item.key}
                row={line.row}
                columns={columns}
                showAccount={showAccount}
                showBalance={showBalance && !showAccount}
                top={top}
                rowIndex={rowIndex}
              />
            )
          }
          return line.kind === "split" ? (
            <SplitRow
              key={item.key}
              tx={line.tx}
              columns={columns}
              showAccount={showAccount}
              showBalance={showBalance && !showAccount}
              top={top}
              rowIndex={rowIndex}
            />
          ) : (
            <TransactionRow
              key={item.key}
              tx={line.tx}
              columns={columns}
              showAccount={showAccount}
              showBalance={showBalance && !showAccount}
              selected={selected.has(line.tx.id)}
              onSelect={onSelect}
              splits={childrenByParent[line.tx.id]}
              expanded={expanded.has(line.tx.id)}
              onToggleExpand={onToggleExpand}
              accountId={accountId}
              today={today}
              top={top}
              rowIndex={rowIndex}
            />
          )
        })}
      </div>
    </div>
  )
}

function ScheduledLine({
  row,
  columns,
  showAccount,
  showBalance,
  top,
  rowIndex,
}: {
  row: ScheduledRow
  columns: string
  showAccount: boolean
  showBalance: boolean
  top: number
  rowIndex: number
}) {
  const s = useScheduledRow(row)
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-testid="scheduled-row"
      className={cx(columns, "group absolute inset-x-0 top-0 h-9 border-b border-line-subtle px-5 text-muted hover:bg-hover")}
      style={{ transform: `translateY(${top}px)` }}
    >
      <CalendarClock size={13} className="text-faint" aria-label="Échéance" />
      <span className={cx("num text-[12px]", row.overdue && "text-warning")}>{s.date}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate italic">{row.name}</span>
        <Chip>Échéance</Chip>
        {row.next ? (
          <span className={cx("ml-auto flex shrink-0 gap-1", revealOnHover)}>
            <Button size="sm" variant="ghost" disabled={s.busy} onClick={s.skip}>
              Passer
            </Button>
            <Button size="sm" disabled={s.busy} onClick={s.post}>
              Enregistrer
            </Button>
          </span>
        ) : null}
      </span>
      <span className="truncate">{s.category}</span>
      {showAccount ? <span className="truncate">{s.account}</span> : null}
      <Money value={row.amount} sign="always" className="text-right italic" />
      {showBalance ? <span /> : null}
      <span />
      <span />
    </div>
  )
}

const SplitRow = ({
  tx,
  columns,
  showAccount,
  showBalance,
  top,
  rowIndex,
}: {
  tx: TxRow
  columns: string
  showAccount: boolean
  showBalance: boolean
  top: number
  rowIndex: number
}) => (
  <div
    role="row"
    aria-rowindex={rowIndex}
    className={cx(columns, "absolute inset-x-0 top-0 h-8 border-b border-line-subtle px-5 text-[12px] text-muted")}
    style={{ transform: `translateY(${top}px)` }}
  >
    <span />
    <span />
    <span className="truncate pl-4">{tx.notes ?? ""}</span>
    <InlineCategory tx={tx} />
    {showAccount ? <span /> : null}
    <Money value={tx.amount} className="text-right" colored />
    {showBalance ? <span /> : null}
    <span />
    <span />
  </div>
)

// Memoized: a refetch keeps unchanged rows by reference (structural sharing), so only edited
// rows re-render instead of the whole page with its pickers.
const TransactionRow = React.memo(function TransactionRow({
  tx,
  columns,
  showAccount,
  showBalance,
  selected,
  onSelect,
  splits,
  expanded,
  onToggleExpand,
  accountId,
  today,
  top,
  rowIndex,
}: {
  tx: TxRow
  columns: string
  showAccount: boolean
  showBalance: boolean
  selected: boolean
  onSelect: (id: string, checked: boolean) => void
  splits: TxRow[] | undefined
  expanded: boolean
  onToggleExpand: (id: string) => void
  accountId: string | undefined
  today: string
  top: number
  rowIndex: number
}) {
  const [dialog, setDialog] = React.useState<null | "edit" | "rule" | "schedule">(null)
  const update = useAction(updateTransaction)
  const cleared = useAction(setTransactionsCleared)
  const remove = useDeleteTransactions()
  const duplicate = useAction(createTransaction, { success: "Opération dupliquée" })
  const future = tx.date > today
  const describe = `${tx.payeeName ?? "opération"} du ${formatDayShort(tx.date)}, ${formatMoney(tx.amount)}`

  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-testid="tx-row"
      className={cx(
        columns,
        "group absolute inset-x-0 top-0 h-9 border-b border-line-subtle px-5 hover:bg-hover",
        selected && "bg-accent-soft hover:bg-accent-soft",
        future && "text-muted",
      )}
      style={{ transform: `translateY(${top}px)` }}
    >
      <Checkbox checked={selected} onCheckedChange={(c) => onSelect(tx.id, c)} label={`Sélectionner ${describe}`} />
      <InlineDate tx={tx} />
      <span className="flex min-w-0 items-center gap-1.5">
        <PayeePicker
          value={payeeValueOf(tx)}
          onChange={(p) => update.mutate({ data: { id: tx.id, payee: payeeInputOf(p) } })}
          currentAccountId={tx.accountId}
          variant="inline"
          className="min-w-0 flex-1"
          triggerClassName="truncate"
          placeholder="—"
        />
        {tx.notes ? <span className="truncate text-[12px] text-faint">{tx.notes}</span> : null}
      </span>
      {tx.isParent ? (
        <button type="button" onClick={() => onToggleExpand(tx.id)} className="flex items-center gap-1 text-muted hover:text-fg">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Ventilée ({splits?.length ?? 0})
        </button>
      ) : tx.transferAccountId && !tx.categoryId ? (
        <span className="text-faint">Virement</span>
      ) : (
        <InlineCategory tx={tx} />
      )}
      {showAccount ? <span className="truncate text-muted">{tx.accountName}</span> : null}
      <InlineAmount tx={tx} />
      {showBalance ? <Money value={tx.balance ?? 0} className="text-right text-[12px] text-muted" /> : null}
      <button
        type="button"
        aria-label={tx.reconciled ? "Rapprochée" : tx.cleared ? "Pointée" : "Non pointée"}
        title={tx.reconciled ? "Rapprochée (verrouillée)" : tx.cleared ? "Pointée" : "Non pointée"}
        disabled={tx.reconciled}
        onClick={() => cleared.mutate({ data: { ids: [tx.id], cleared: !tx.cleared } })}
        className="flex h-6 w-6 items-center justify-center"
      >
        {tx.reconciled ? (
          <Lock size={11} className="text-faint" />
        ) : (
          <span className={cx("h-2 w-2 rounded-full border", tx.cleared ? "border-positive bg-positive" : "border-control-off")} />
        )}
      </button>
      <Menu
        trigger={
          <IconButton label={`Actions ${describe}`} size="sm" className={revealOnHover}>
            <MoreHorizontal size={14} />
          </IconButton>
        }
        items={[
          { label: "Modifier…", icon: <Pencil size={13} />, onSelect: () => setDialog("edit") },
          { label: "Ventiler…", icon: <Split size={13} />, onSelect: () => setDialog("edit"), disabled: !!tx.transferAccountId },
          {
            label: "Dupliquer",
            icon: <Copy size={13} />,
            onSelect: () =>
              duplicate.mutate({
                data: {
                  accountId: tx.accountId,
                  date: today,
                  amount: tx.amount,
                  payee: payeeInputOf(payeeValueOf(tx)),
                  categoryId: tx.categoryId,
                  notes: tx.notes,
                },
              }),
          },
          { label: "Toujours catégoriser ainsi…", icon: <Wand2 size={13} />, onSelect: () => setDialog("rule"), disabled: !tx.payeeName },
          { label: "Rendre récurrente…", icon: <CalendarClock size={13} />, onSelect: () => setDialog("schedule") },
          { separator: true },
          {
            label: "Supprimer",
            icon: <Trash2 size={13} />,
            danger: true,
            onSelect: () => remove.mutate([tx.id]),
            disabled: !!tx.parentId,
          },
        ]}
      />
      {dialog === "edit" ? <TransactionEditor tx={tx} splits={splits} onClose={() => setDialog(null)} /> : null}
      {dialog === "rule" ? <RuleFromTransactionDialog tx={tx} onClose={() => setDialog(null)} /> : null}
      {dialog === "schedule" ? (
        <ScheduleDialog
          initial={{
            name: tx.payeeName ?? "",
            payee: payeeValueOf(tx),
            accountId: accountId ?? tx.accountId,
            categoryId: tx.categoryId,
            amount: tx.amount,
            startDate: tx.date,
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  )
})

function InlineDate({ tx }: { tx: TxRow }) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(tx.date)
  const update = useAction(updateTransaction)
  const save = (date: Day) => {
    setOpen(false)
    if (date && date !== tx.date) update.mutate({ data: { id: tx.id, date } })
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next, reason) => {
        if (next) setDraft(tx.date)
        else if (reason !== "escape-key") save(draft)
        setOpen(next)
      }}
      trigger={
        <button type="button" disabled={!!tx.parentId} className="num text-left text-[12px] text-muted" title={formatDayLong(tx.date)}>
          {formatDayShort(tx.date)}
        </button>
      }
    >
      <div className="border-b border-line p-2.5">
        <DateInput
          autoFocus
          calendar={false}
          aria-label="Date"
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") save(parseDayInput(e.currentTarget.value, draft) ?? draft)
          }}
        />
      </div>
      {/* A typed date in another month shows that month. */}
      <Calendar key={draft ? monthOf(draft) : ""} value={draft} onSelect={save} />
    </Popover>
  )
}

function InlineCategory({ tx }: { tx: TxRow }) {
  const update = useAction(updateTransaction)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <CategoryPicker
        value={tx.categoryId}
        onChange={(categoryId) => update.mutate({ data: { id: tx.id, categoryId } })}
        variant="inline"
        className="min-w-0"
        triggerClassName={cx("truncate", !tx.categoryId && "text-warning")}
        placeholder="À catégoriser"
      />
      <SuggestionChip tx={tx} />
    </span>
  )
}

function InlineAmount({ tx }: { tx: TxRow }) {
  const update = useAction(updateTransaction)
  return (
    <InlineEdit
      value={amountInput(tx.amount)}
      label="Montant"
      inputMode="decimal"
      disabled={tx.isParent || !!tx.parentId}
      onCommit={(text) => {
        const value = parseAmount(text)
        if (value !== null && value !== tx.amount) update.mutate({ data: { id: tx.id, amount: value } })
      }}
      className="text-right"
      inputClassName="num w-full text-right text-[12px]"
    >
      <Money value={tx.amount} sign="always" colored className="text-[12px]" />
    </InlineEdit>
  )
}

// --- Mobile list -----------------------------------------------------------------

type MobileLine = { kind: "tx"; tx: TxRow } | { kind: "scheduled"; row: ScheduledRow }

function MobileList({
  rows,
  scheduled,
  childrenByParent,
  onReachEnd,
}: {
  rows: TxRow[]
  scheduled: ScheduledRow[]
  childrenByParent: Record<string, TxRow[]>
  onReachEnd: () => void
}) {
  const [editing, setEditing] = React.useState<TxRow | null>(null)
  const [categorizing, setCategorizing] = React.useState<TxRow | null>(null)
  const remove = useDeleteTransactions()
  const update = useAction(updateTransaction)
  const lines = React.useMemo(
    () => interleave<MobileLine>(rows, scheduled, (tx) => [{ kind: "tx", tx }], (row) => ({ kind: "scheduled", row })),
    [rows, scheduled],
  )
  const list = useWindowList({
    count: lines.length,
    estimateSize: () => 64,
    getItemKey: (i) => {
      const line = lines[i]
      return !line ? String(i) : line.kind === "scheduled" ? scheduledKey(line.row) : line.tx.id
    },
    onReachEnd,
  })
  return (
    <div>
      <div ref={list.ref} className="relative" style={{ height: list.virtualizer.getTotalSize() }}>
        {list.items.map((item) => {
          const line = lines[item.index]
          if (!line) return null
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={list.virtualizer.measureElement}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${list.offset(item)}px)` }}
            >
              {line.kind === "scheduled" ? (
                <MobileScheduledRow row={line.row} />
              ) : (
                <SwipeRow
                  onOpen={() => setEditing(line.tx)}
                  actions={[
                    { label: "Catégoriser", tone: "accent", run: () => setCategorizing(line.tx) },
                    { label: "Supprimer", tone: "danger", run: () => remove.mutate([line.tx.id]) },
                  ]}
                >
                  <button type="button" onClick={() => setEditing(line.tx)} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                    <span className="truncate font-medium">{line.tx.payeeName ?? line.tx.notes ?? "—"}</span>
                    <span className={cx("truncate text-[12px] text-faint", !line.tx.categoryId && !line.tx.transferAccountId && !line.tx.isParent && "text-warning")}>
                      {formatDayShort(line.tx.date)} · {line.tx.isParent ? "Ventilée" : line.tx.transferAccountId && !line.tx.categoryId ? "Virement" : (line.tx.categoryName ?? "À catégoriser")}
                    </span>
                  </button>
                  <SuggestionChip tx={line.tx} compact />
                  <Money value={line.tx.amount} sign="always" colored className="text-[14px]" />
                </SwipeRow>
              )}
            </div>
          )
        })}
      </div>
      {editing ? <TransactionEditor tx={editing} splits={childrenByParent[editing.id]} onClose={() => setEditing(null)} /> : null}
      {categorizing ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setCategorizing(null)}
          title={categorizing.payeeName ? `Catégoriser « ${categorizing.payeeName} »` : "Catégoriser l'opération"}
        >
          <div className="px-5 py-4">
            <CategoryPicker
              value={categorizing.categoryId}
              autoOpen
              onChange={(categoryId) => {
                update.mutate({ data: { id: categorizing.id, categoryId } })
                setCategorizing(null)
              }}
            />
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

function MobileScheduledRow({ row }: { row: ScheduledRow }) {
  const s = useScheduledRow(row)
  return (
    <div data-testid="scheduled-row" className="flex items-center gap-3 border-b border-line-subtle px-5 py-3 text-muted">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium italic">{row.name}</span>
        <span className="truncate text-[12px] text-faint">
          <span className={cx(row.overdue && "text-warning")}>{s.date}</span> · Échéance · {s.category}
        </span>
      </div>
      <Money value={row.amount} sign="always" className="text-[14px] italic" />
      {row.next ? (
        <Menu
          trigger={
            <IconButton label="Actions de l'échéance" disabled={s.busy}>
              <MoreHorizontal size={15} />
            </IconButton>
          }
          items={[
            { label: "Enregistrer", icon: <Check size={13} />, onSelect: s.post },
            { label: "Passer", icon: <SkipForward size={13} />, onSelect: s.skip },
          ]}
        />
      ) : null}
    </div>
  )
}

/** A list row that reveals actions when swiped to the left. */
function SwipeRow({
  children,
  actions,
  onOpen,
}: {
  children: React.ReactNode
  actions: Array<{ label: string; tone: "accent" | "danger"; run: () => void }>
  onOpen: () => void
}) {
  const [offset, setOffset] = React.useState(0)
  const start = React.useRef<{ x: number; y: number; base: number } | null>(null)
  const width = actions.length * 96
  return (
    <div className="relative overflow-hidden border-b border-line-subtle">
      {/* Hidden under the row until it is swiped open: out of reach for Tab and screen readers until then. */}
      <div className="absolute inset-y-0 right-0 flex" inert={offset === 0}>
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={() => {
              setOffset(0)
              a.run()
            }}
            className={cx("w-24 text-[13px] font-medium text-white", a.tone === "danger" ? "bg-negative-solid" : "bg-accent-solid")}
          >
            {a.label}
          </button>
        ))}
      </div>
      {/* Not a button itself: it holds the row's own buttons. Keyboard users open the row through the payee button. */}
      <div
        className="relative flex items-center gap-3 bg-bg px-5 py-[11px] transition-transform duration-150"
        style={{ transform: `translateX(${offset}px)` }}
        onTouchStart={(e) => {
          const t = e.touches[0]
          if (t) start.current = { x: t.clientX, y: t.clientY, base: offset }
        }}
        onTouchMove={(e) => {
          const t = e.touches[0]
          if (!t || !start.current) return
          const dx = t.clientX - start.current.x
          if (Math.abs(dx) < Math.abs(t.clientY - start.current.y)) return
          setOffset(Math.max(-width, Math.min(0, start.current.base + dx)))
        }}
        onTouchEnd={() => {
          setOffset((o) => (o < -width / 2 ? -width : 0))
          start.current = null
        }}
        onClick={(e) => {
          if (offset !== 0) setOffset(0)
          else if (!(e.target as HTMLElement).closest("button")) onOpen()
        }}
      >
        {children}
      </div>
    </div>
  )
}


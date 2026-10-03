import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Copy,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Split,
  Trash2,
  Wand2,
  X,
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
} from "~/components/transaction-editor"
import { Button, Checkbox, cx, Dialog, EmptyState, IconButton, Input, Menu, Money, SkeletonRows } from "~/components/ui"
import { formatDayLong, formatDayShort, formatMonthLong } from "~/domain/dates"
import { amountInput, parseAmount } from "~/domain/money"
import { shortcutBlocked, useDebounced, useIsMobile, useToday } from "~/lib/hooks"
import { q, useAction } from "~/lib/queries"
import {
  createTransaction,
  deleteAccount,
  deleteTransactions,
  setAccountClosed,
  setTransactionsCategory,
  setTransactionsCleared,
  updateTransaction,
} from "~/server/fns/core"
import type { TxPage, TxRow } from "~/server/services/transactions"
import { count, plural } from "~/domain/text"

type Search = { categoryId?: string; month?: string; uncategorized?: boolean; q?: string }

export const Route = createFileRoute("/_app/accounts/$accountId")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.categoryId === "string" ? { categoryId: s.categoryId } : {}),
    ...(typeof s.month === "string" ? { month: s.month } : {}),
    ...(s.uncategorized ? { uncategorized: true } : {}),
    ...(typeof s.q === "string" ? { q: s.q } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(q.categories()),
      context.queryClient.ensureInfiniteQueryData(
        q.transactions({
          ...(params.accountId === "all" ? {} : { accountId: params.accountId }),
          ...(deps.categoryId ? { categoryId: deps.categoryId } : {}),
          ...(deps.month ? { month: deps.month } : {}),
          ...(deps.uncategorized ? { uncategorized: true } : {}),
          ...(deps.q?.trim() ? { search: deps.q.trim() } : {}),
        }),
      ),
    ]),
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

  const closeAccount = useAction(setAccountClosed, { success: "Compte mis à jour" })
  const removeAccount = useAction(deleteAccount, {
    success: "Compte supprimé",
    onSuccess: () => void navigate({ to: "/accounts" }),
  })

  const categoryName = categories.data?.flatMap((g) => g.categories).find((c) => c.id === search.categoryId)?.name
  const title = all ? "Toutes les opérations" : (account?.name ?? "Compte")
  const hasFilters = search.categoryId || search.month || search.uncategorized
  const suggestions = useCategorySuggestions(rows)

  return (
    <>
      <PageHeader
        title="Comptes"
        crumb={title}
        right={
          <>
            {account ? (
              <span className="mr-2 flex items-baseline gap-2 max-md:hidden">
                <span className="text-muted">Solde</span>
                <Money value={account.balance} className="text-[14px]" />
              </span>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              icon={<Plus size={13} />}
              onClick={() => openNewTransaction(all ? {} : { accountId })}
              className="max-md:hidden"
            >
              Opération
            </Button>
            {account ? (
              <>
                <Button size="sm" onClick={() => setDialog("reconcile")} className="max-md:hidden">
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
                      onSelect: () => {
                        if (window.confirm(`Supprimer « ${account.name} »${account.transactionCount === 1 ? " et son opération" : account.transactionCount > 1 ? ` et ses ${count(account.transactionCount, "opération")}` : ""} ?`)) {
                          removeAccount.mutate({ data: { id: account.id } })
                        }
                      },
                    },
                  ]}
                />
              </>
            ) : null}
          </>
        }
      />
      {mobile && account ? (
        <div className="flex flex-col gap-1.5 border-b border-line px-5 pb-4">
          <Money value={account.balance} className="text-[32px] font-medium tracking-[-0.02em]" />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2 max-md:border-none max-md:pt-3">
        <div className="relative w-[280px] max-md:w-full">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            ref={searchRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Rechercher"
            aria-label="Rechercher une opération"
            className="pl-8 max-md:h-9 max-md:border-none max-md:bg-subtle"
          />
          {!mobile ? <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-faint">/</span> : null}
        </div>
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
      ) : rows.length === 0 ? (
        <EmptyState
          title={hasFilters || debounced ? "Aucune opération ne correspond." : "Aucune opération sur ce compte."}
          action={
            <Button variant="primary" onClick={() => openNewTransaction(all ? {} : { accountId })}>
              Ajouter
            </Button>
          }
        />
      ) : mobile ? (
        <MobileList rows={rows} childrenByParent={childrenByParent} />
      ) : (
        <TransactionTable
          rows={rows}
          childrenByParent={childrenByParent}
          showAccount={all}
          showBalance={rows[0]?.balance !== null}
          selected={selected}
          setSelected={setSelected}
          accountId={all ? undefined : accountId}
        />
      )}
      </SuggestionsProvider>
      {txs.hasNextPage ? (
        <div className="flex justify-center py-4">
          <Button variant="ghost" onClick={() => void txs.fetchNextPage()} loading={txs.isFetchingNextPage}>
            Afficher plus ({count(total - rows.length, "restante")})
          </Button>
        </div>
      ) : null}
      {dialog === "edit-account" && account ? <EditAccountDialog account={account} onClose={() => setDialog(null)} /> : null}
      {dialog === "reconcile" && account ? <ReconcileDialog account={account} onClose={() => setDialog(null)} /> : null}
    </>
  )
}

const FilterChip = ({ label, onClear }: { label: string; onClear: () => void }) => (
  <span className="flex items-center gap-1.5 rounded-[6px] border border-line-control bg-subtle py-1 pl-2.5 pr-1.5">
    {label}
    <button type="button" aria-label={`Retirer le filtre ${label}`} onClick={onClear} className="text-faint hover:text-fg">
      <X size={12} />
    </button>
  </span>
)

function BulkBar({ ids, rows, onDone }: { ids: string[]; rows: TxRow[]; onDone: () => void }) {
  const setCategory = useAction(setTransactionsCategory, { success: "Catégorie appliquée", onSuccess: onDone })
  const setCleared = useAction(setTransactionsCleared, { onSuccess: onDone })
  const remove = useAction(deleteTransactions, { success: `${count(ids.length, "opération")} ${plural(ids.length, "supprimée")}`, onSuccess: onDone })
  const allCleared = rows.filter((r) => ids.includes(r.id)).every((r) => r.cleared)
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
        onClick={() => window.confirm(`Supprimer ${count(ids.length, "opération")} ?`) && remove.mutate({ data: { ids } })}
      >
        Supprimer
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone} className="ml-auto">
        Annuler
      </Button>
    </div>
  )
}

// --- Desktop table -----------------------------------------------------------------

function TransactionTable({
  rows,
  childrenByParent,
  showAccount,
  showBalance,
  selected,
  setSelected,
  accountId,
}: {
  rows: TxRow[]
  childrenByParent: Record<string, TxRow[]>
  showAccount: boolean
  showBalance: boolean
  selected: Set<string>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  accountId: string | undefined
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
  return (
    <div role="table" aria-label="Opérations">
      <div role="row" className={cx(columns, "h-[34px] border-b border-line px-5 text-[12px] text-faint")}>
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
      {rows.map((tx) => (
        <React.Fragment key={tx.id}>
          <TransactionRow
            tx={tx}
            columns={columns}
            showAccount={showAccount}
            showBalance={showBalance && !showAccount}
            selected={selected.has(tx.id)}
            onSelect={onSelect}
            splits={childrenByParent[tx.id]}
            expanded={expanded.has(tx.id)}
            onToggleExpand={onToggleExpand}
            accountId={accountId}
            today={today}
          />
          {tx.isParent && expanded.has(tx.id)
            ? (childrenByParent[tx.id] ?? []).map((child) => (
                <div key={child.id} role="row" className={cx(columns, "h-8 border-b border-line-subtle px-5 text-[12px] text-muted")}>
                  <span />
                  <span />
                  <span className="truncate pl-4">{child.notes ?? ""}</span>
                  <InlineCategory tx={child} />
                  {showAccount ? <span /> : null}
                  <Money value={child.amount} className="text-right" colored />
                  {showBalance && !showAccount ? <span /> : null}
                  <span />
                  <span />
                </div>
              ))
            : null}
        </React.Fragment>
      ))}
    </div>
  )
}

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
}) {
  const [dialog, setDialog] = React.useState<null | "edit" | "rule" | "schedule">(null)
  const update = useAction(updateTransaction)
  const cleared = useAction(setTransactionsCleared)
  const remove = useAction(deleteTransactions, { success: "Opération supprimée" })
  const duplicate = useAction(createTransaction, { success: "Opération dupliquée" })
  const future = tx.date > today

  return (
    <div
      role="row"
      data-testid="tx-row"
      className={cx(
        columns,
        "group h-9 border-b border-line-subtle px-5 hover:bg-hover",
        selected && "bg-accent-soft hover:bg-accent-soft",
        future && "text-muted",
      )}
    >
      <Checkbox checked={selected} onCheckedChange={(c) => onSelect(tx.id, c)} label="Sélectionner" />
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
          <span className={cx("h-2 w-2 rounded-full border", tx.cleared ? "border-positive bg-positive" : "border-line-strong")} />
        )}
      </button>
      <Menu
        trigger={
          <IconButton label="Actions" size="sm" className="opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
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
            onSelect: () => remove.mutate({ data: { ids: [tx.id] } }),
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
  const [editing, setEditing] = React.useState(false)
  const update = useAction(updateTransaction)
  if (editing) {
    return (
      <input
        type="date"
        autoFocus
        defaultValue={tx.date}
        aria-label="Date"
        onBlur={(e) => {
          setEditing(false)
          if (e.target.value && e.target.value !== tx.date) update.mutate({ data: { id: tx.id, date: e.target.value } })
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "Escape") setEditing(false)
        }}
        className="num h-7 w-full rounded-[6px] border border-accent-line bg-bg px-1 text-[12px] outline-none"
      />
    )
  }
  return (
    <button type="button" onClick={() => setEditing(true)} className="num text-left text-[12px] text-muted" title={formatDayLong(tx.date)}>
      {formatDayShort(tx.date)}
    </button>
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
  const [editing, setEditing] = React.useState(false)
  const [text, setText] = React.useState("")
  const update = useAction(updateTransaction)
  if (editing) {
    const commit = () => {
      setEditing(false)
      const value = parseAmount(text)
      if (value !== null && value !== tx.amount) update.mutate({ data: { id: tx.id, amount: value } })
    }
    return (
      <input
        autoFocus
        value={text}
        aria-label="Montant"
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
          if (e.key === "Escape") setEditing(false)
        }}
        className="num h-7 w-full rounded-[6px] border border-accent-line bg-bg px-2 text-right text-[12px] outline-none"
      />
    )
  }
  return (
    <button
      type="button"
      disabled={tx.isParent}
      onClick={() => {
        setText(amountInput(tx.amount))
        setEditing(true)
      }}
      className="text-right"
    >
      <Money value={tx.amount} sign="always" colored className="text-[12px]" />
    </button>
  )
}

// --- Mobile list -----------------------------------------------------------------

function MobileList({ rows, childrenByParent }: { rows: TxRow[]; childrenByParent: Record<string, TxRow[]> }) {
  const [editing, setEditing] = React.useState<TxRow | null>(null)
  const [categorizing, setCategorizing] = React.useState<TxRow | null>(null)
  const remove = useAction(deleteTransactions, { success: "Opération supprimée" })
  const update = useAction(updateTransaction)
  return (
    <div>
      {rows.map((tx) => (
        <SwipeRow
          key={tx.id}
          onOpen={() => setEditing(tx)}
          actions={[
            { label: "Catégoriser", tone: "accent", run: () => setCategorizing(tx) },
            { label: "Supprimer", tone: "danger", run: () => remove.mutate({ data: { ids: [tx.id] } }) },
          ]}
        >
          <button type="button" onClick={() => setEditing(tx)} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
            <span className="truncate font-medium">{tx.payeeName ?? tx.notes ?? "—"}</span>
            <span className={cx("truncate text-[12px] text-faint", !tx.categoryId && !tx.transferAccountId && !tx.isParent && "text-warning")}>
              {formatDayShort(tx.date)} · {tx.isParent ? "Ventilée" : tx.transferAccountId && !tx.categoryId ? "Virement" : (tx.categoryName ?? "À catégoriser")}
            </span>
          </button>
          <SuggestionChip tx={tx} compact />
          <Money value={tx.amount} sign="always" colored className="text-[14px]" />
        </SwipeRow>
      ))}
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
      <div className="absolute inset-y-0 right-0 flex">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={() => {
              setOffset(0)
              a.run()
            }}
            className={cx("w-24 text-[13px] font-medium text-white", a.tone === "danger" ? "bg-[var(--negative)]" : "bg-accent")}
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


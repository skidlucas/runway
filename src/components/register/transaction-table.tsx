import { CalendarClock, ChevronDown, ChevronRight, Copy, MoreHorizontal, Pencil, Split, Trash2, Wand2 } from "lucide-react"
import * as React from "react"
import { SuggestionChip } from "~/components/category-suggestions"
import { CategoryPicker, PayeePicker } from "~/components/pickers"
import { ScheduleDialog } from "~/components/schedule-dialog"
import {
  RuleFromTransactionDialog,
  TransactionEditor,
  payeeInputOf,
  payeeValueOf,
  useDeleteTransactions,
} from "~/components/transaction-editor"
import { Button, Calendar, Checkbox, Chip, cx, DateInput, IconButton, InlineEdit, Menu, Money, Popover, revealOnHover } from "~/components/ui"
import { type Day, formatDayLong, formatDayShort, monthOf, parseDayInput } from "~/domain/dates"
import { amountInput, formatMoney, parseAmount } from "~/domain/money"
import { useToday } from "~/lib/hooks"
import { useAction } from "~/lib/queries"
import { useWindowList } from "~/lib/use-window-list"
import { createTransaction, setTransactionsCleared, updateTransaction } from "~/server/fns/core"
import type { ScheduledRow } from "~/server/services/schedules"
import type { TxRow } from "~/server/services/transactions"
import { ClearedMark } from "./cleared-mark"
import { interleave, scheduledKey, useScheduledRow } from "./scheduled"

type Line = { kind: "tx"; tx: TxRow } | { kind: "split"; tx: TxRow } | { kind: "scheduled"; row: ScheduledRow }

export function TransactionTable({
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
        <span className="truncate italic" title={row.name}>{row.name}</span>
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
      <span className="truncate" title={s.category}>{s.category}</span>
      {showAccount ? <span className="truncate" title={s.account}>{s.account}</span> : null}
      <Money value={row.amount} sign="always" className="text-right italic" />
      {showBalance ? <span /> : null}
      <span />
      {s.confirmDialog}
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
    <span className="truncate pl-4" title={tx.notes ?? ""}>{tx.notes ?? ""}</span>
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
  const update = useAction(updateTransaction, { writes: ["transactions"] })
  const cleared = useAction(setTransactionsCleared, { writes: ["cleared"] })
  const remove = useDeleteTransactions()
  const duplicate = useAction(createTransaction, { success: "Opération dupliquée", writes: ["transactions"] })
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
        {tx.notes ? <span className="truncate text-[12px] text-faint" title={tx.notes}>{tx.notes}</span> : null}
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
      {showAccount ? <span className="truncate text-muted" title={tx.accountName}>{tx.accountName}</span> : null}
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
        <ClearedMark tx={tx} />
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
  const update = useAction(updateTransaction, { writes: ["transactions"] })
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
  const update = useAction(updateTransaction, { writes: ["transactionCategories"] })
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
  const update = useAction(updateTransaction, { writes: ["transactions"] })
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

import { Check, MoreHorizontal, SkipForward } from "lucide-react"
import * as React from "react"
import { SuggestionChip } from "~/components/category-suggestions"
import { CategoryPicker } from "~/components/pickers"
import { TransactionEditor, useDeleteTransactions } from "~/components/transaction-editor"
import { cx, Dialog, IconButton, Menu, Money } from "~/components/ui"
import { formatDayShort } from "~/domain/dates"
import { useAction } from "~/lib/queries"
import { useWindowList } from "~/lib/use-window-list"
import { updateTransaction } from "~/server/fns/core"
import type { ScheduledRow } from "~/server/services/schedules"
import type { TxRow } from "~/server/services/transactions"
import { interleave, scheduledKey, useScheduledRow } from "./scheduled"

type MobileLine = { kind: "tx"; tx: TxRow } | { kind: "scheduled"; row: ScheduledRow }

export function MobileList({
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
  const update = useAction(updateTransaction, { writes: ["transactionCategories"] })
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
        <span className="truncate font-medium italic" title={row.name}>{row.name}</span>
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

import { AlertTriangle, CalendarClock } from "lucide-react"
import * as React from "react"
import { Button, cx, Popover } from "~/components/ui"
import { formatDayLong, formatDayShort, formatMonthLong, monthOf } from "~/domain/dates"
import { formatMoney } from "~/domain/money"
import { type PlannedCategory, type PlannedStatus, plannedStatus } from "~/domain/planned"
import { useAction } from "~/lib/queries"
import { setBudgetAmount } from "~/server/fns/core"
import type { BudgetCategoryRow } from "~/server/services/budget"

export const statusOf = (category: BudgetCategoryRow): PlannedStatus =>
  category.planned ? plannedStatus(category.planned, category.budgeted) : "covered"

export const StatusIcon = ({ status, size }: { status: PlannedStatus; size: number }) =>
  status === "short" ? (
    <AlertTriangle size={size} className="shrink-0 text-warning" aria-label="Échéances du mois non couvertes" />
  ) : status === "upcoming" ? (
    <CalendarClock size={size} className="shrink-0 text-muted" aria-label="Échéances à venir à anticiper" />
  ) : null

export function PlannedStatusNote({ category }: { category: BudgetCategoryRow }) {
  const planned = category.planned
  const status = statusOf(category)
  if (!planned || status === "covered") return null
  return (
    <p className={cx("mt-3 text-[12px]", status === "short" ? "text-warning" : "text-muted")}>
      {status === "short"
        ? `Il manque ${formatMoney(planned.thisMonth - planned.saved - category.budgeted)} pour les échéances de ce mois.`
        : `Ce mois-ci est couvert. ${formatMoney(planned.target - category.budgeted)} de plus à mettre de côté pour les échéances à venir.`}
    </p>
  )
}

export function PlannedCell({ category, month }: { category: BudgetCategoryRow; month: string }) {
  const [open, setOpen] = React.useState(false)
  const save = useAction(setBudgetAmount, { writes: ["budgets"], onSuccess: () => setOpen(false) })
  const planned = category.planned
  if (!planned) return <span className="num text-right text-[12px] text-faint">—</span>
  const status = statusOf(category)
  return (
    <span className="flex justify-end">
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        className="w-[340px] p-3"
        trigger={
          <button
            type="button"
            aria-label={`Prévu ${category.name} : ${formatMoney(planned.amount)}`}
            className={cx(
              "num -mr-2 flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12px] hover:bg-active",
              status === "short" ? "text-warning" : "text-faint",
            )}
          >
            <StatusIcon status={status} size={12} />
            {formatMoney(planned.amount)}
          </button>
        }
      >
        <PlannedDetail planned={planned} />
        <PlannedStatusNote category={category} />
        {status === "covered" ? null : (
          <Button
            variant="primary"
            size="sm"
            className="mt-3 w-full"
            loading={save.isPending}
            onClick={() => save.mutate({ data: { month, categoryId: category.id, amount: planned.target } })}
          >
            Budgéter {formatMoney(planned.target)}
          </Button>
        )}
      </Popover>
    </span>
  )
}

export function PlannedDetail({ planned }: { planned: PlannedCategory }) {
  const spaced = planned.lines.some((l) => l.kind === "setAside")
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      {planned.lines.map((l) => (
        <div key={l.scheduleId} className="flex flex-col">
          <span className="flex items-baseline justify-between gap-3">
            <span className="truncate text-fg-2" title={l.name}>{l.name}</span>
            <span className="num shrink-0">
              {l.count > 1 ? `${l.count} × ` : ""}
              {formatMoney(l.amount)}
            </span>
          </span>
          <span className="text-[11px] text-faint">
            {l.kind === "due"
              ? `${l.count > 1 ? "dès le" : "le"} ${formatDayShort(l.date)}`
              : `le ${formatDayLong(l.date)}${l.monthsLeft === 1 ? ", ce mois-ci" : `, lissé sur ${l.monthsLeft} mois`}`}
            {l.remaining ? ` · encore ${l.remaining.count} × ${formatMoney(l.amount)} jusqu'en ${formatMonthLong(monthOf(l.remaining.until)).toLowerCase()}` : ""}
          </span>
        </div>
      ))}
      <div className="mt-1 flex flex-col gap-1 border-t border-line pt-2">
        {planned.due && spaced ? <PlannedTotal label="À payer ce mois" value={planned.due} /> : null}
        {spaced ? (
          <PlannedTotal label={`À mettre de côté (déjà ${formatMoney(Math.max(0, planned.saved - planned.due))})`} value={planned.setAside} />
        ) : null}
        <PlannedTotal label="Prévu ce mois" value={planned.amount} strong />
        {planned.target < planned.amount ? (
          <>
            <PlannedTotal label="Déjà dans l'enveloppe" value={planned.target - planned.amount} />
            <PlannedTotal label="À mettre ce mois" value={planned.target} strong />
          </>
        ) : null}
      </div>
    </div>
  )
}

const PlannedTotal = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => (
  <span className={cx("flex justify-between gap-3", strong ? "font-medium text-fg" : "text-muted")}>
    <span>{label}</span>
    <span className="num">{formatMoney(value)}</span>
  </span>
)

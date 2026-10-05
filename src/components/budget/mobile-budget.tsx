import * as React from "react"
import { AmountPill, Button, cx, Dialog, Field, Input } from "~/components/ui"
import { amountInput, formatMoney, parseAmount } from "~/domain/money"
import { useAction } from "~/lib/queries"
import { setBudgetAmount } from "~/server/fns/core"
import type { BudgetCategoryRow, BudgetMonthDto } from "~/server/services/budget"
import { type MoveMode, MoveMoneyDialog } from "./move-money"
import { PlannedDetail, PlannedStatusNote, StatusIcon, statusOf } from "./planned"
import { formatSpent } from "./spent"

// Every row shares the columns of the outer grid (subgrid), so the amount columns are as wide as
// their largest figure instead of a fixed width that big amounts overflow. The 8px edge tracks
// plus the gap make the side padding while row backgrounds still reach the edges.
const MOBILE_TABLE = "grid grid-cols-[8px_minmax(0,1fr)_auto_auto_auto_8px] gap-x-2"
const MOBILE_GRID = "col-span-full grid grid-cols-subgrid [&>:first-child]:col-start-2 [&_.num]:whitespace-nowrap"

export function MobileBudget({ budget, month, showHidden }: { budget: BudgetMonthDto; month: string; showHidden: boolean }) {
  const [editing, setEditing] = React.useState<BudgetCategoryRow | null>(null)
  const [moving, setMoving] = React.useState<{ category: BudgetCategoryRow; mode: MoveMode } | null>(null)
  const groups = budget.groups.filter((g) => !g.isIncome && (showHidden || !g.hidden))
  return (
    <div className={MOBILE_TABLE}>
      <div className={cx(MOBILE_GRID, "sticky top-0 z-10 border-b border-line bg-bg py-2 text-[11px] text-muted")}>
        <span>Catégorie</span>
        <span className="text-right">Budgété</span>
        <span className="text-right">Dépensé</span>
        <span className="text-right">Disponible</span>
      </div>
      {groups.map((g) => (
        <section key={g.id} className="col-span-full grid grid-cols-subgrid">
          <div className={cx(MOBILE_GRID, "items-center border-b border-line-subtle bg-row-group py-2 text-[13px] font-medium text-fg-2")}>
            <span className="truncate" title={g.name}>{g.name}</span>
            <span className="num text-right text-[12px]">{formatMoney(g.budgeted, { currency: false })}</span>
            <span className="num text-right text-[12px] text-muted">{formatSpent(g.spent, { currency: false })}</span>
            <span className="num text-right text-[12px]">{formatMoney(g.available, { currency: false })}</span>
          </div>
          {g.categories
            .filter((c) => showHidden || !c.hidden)
            .map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setEditing(c)}
                className={cx(MOBILE_GRID, "min-h-12 w-full items-center border-b border-line-subtle py-2 text-left")}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="line-clamp-2 break-words text-[14px] leading-tight">{c.name}</span>
                  <StatusIcon status={statusOf(c)} size={13} />
                </span>
                <span className="num text-right text-[12px]">{formatMoney(c.budgeted, { currency: false })}</span>
                <span className="num text-right text-[12px] text-muted">{formatSpent(c.spent, { currency: false })}</span>
                <span className="flex justify-end">
                  <AmountPill value={c.available} currency={false} />
                </span>
              </button>
            ))}
        </section>
      ))}
      {editing ? (
        <MobileBudgetDialog
          category={editing}
          month={month}
          onClose={() => setEditing(null)}
          onMove={(mode) => {
            setMoving({ category: editing, mode })
            setEditing(null)
          }}
        />
      ) : null}
      {moving ? (
        <MoveMoneyDialog mode={moving.mode} category={moving.category} month={month} budget={budget} onClose={() => setMoving(null)} />
      ) : null}
    </div>
  )
}

function MobileBudgetDialog({
  category,
  month,
  onClose,
  onMove,
}: {
  category: BudgetCategoryRow
  month: string
  onClose: () => void
  onMove: (mode: MoveMode) => void
}) {
  const [text, setText] = React.useState(category.budgeted ? amountInput(category.budgeted) : "")
  const save = useAction(setBudgetAmount, { onSuccess: onClose, writes: ["budgets"] })
  const value = text.trim() === "" ? 0 : parseAmount(text)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={category.name}
      description={`Dépensé ${formatMoney(category.spent)} · moyenne 3 mois ${formatMoney(category.average3)}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => setText(amountInput(category.average3))}>
            Moyenne
          </Button>
          {category.planned && statusOf(category) !== "covered" ? (
            <Button variant="ghost" onClick={() => setText(amountInput(category.planned?.target ?? 0))}>
              Échéances
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={value === null}
            loading={save.isPending}
            onClick={() => value !== null && save.mutate({ data: { month, categoryId: category.id, amount: value } })}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        {category.planned ? (
          <div>
            <PlannedDetail planned={category.planned} />
            <PlannedStatusNote category={category} />
          </div>
        ) : null}
        <Field label="Budget du mois">
          <Input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} className="num h-11 text-[18px]" autoFocus />
        </Field>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => onMove("cover")}>
            {category.available < 0 ? "Couvrir…" : "Prendre ailleurs…"}
          </Button>
          {category.available > 0 ? (
            <Button className="flex-1" onClick={() => onMove("transfer")}>
              Transférer…
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}

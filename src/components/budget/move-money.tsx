import * as React from "react"
import { CategoryPicker } from "~/components/pickers"
import { AmountPill, Button, cx, Dialog, Field, Input, Money, Popover, Switch } from "~/components/ui"
import { amountInput, formatMoney, parseAmount } from "~/domain/money"
import { useAction } from "~/lib/queries"
import { moveBudget, setBudgetCarryover } from "~/server/fns/core"
import type { BudgetCategoryRow, BudgetMonthDto, MoveTarget } from "~/server/services/budget"

/** "cover" brings money into the category, "transfer" sends some of it elsewhere. */
export type MoveMode = "cover" | "transfer"

export function AvailableMenu({ category, month, budget }: { category: BudgetCategoryRow; month: string; budget: BudgetMonthDto }) {
  const [open, setOpen] = React.useState(false)
  const [mode, setMode] = React.useState<MoveMode | null>(null)
  const carry = useAction(setBudgetCarryover, { writes: ["budgets"] })
  const overspent = category.available < 0
  const start = (next: MoveMode) => {
    setOpen(false)
    setMode(next)
  }
  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        className="w-[260px] p-1"
        trigger={
          <button type="button" aria-label={`Disponible ${category.name}`} className="rounded-[5px]">
            <AmountPill value={category.available} />
          </button>
        }
      >
        <div className="flex flex-col">
          <MenuButton onClick={() => start("cover")}>{overspent ? "Couvrir le dépassement…" : "Prendre dans une autre catégorie…"}</MenuButton>
          {category.available > 0 ? <MenuButton onClick={() => start("transfer")}>Transférer vers une autre catégorie…</MenuButton> : null}
          <label className="flex items-center justify-between gap-3 rounded-[6px] px-2 py-1.5 text-fg-2">
            <span>
              Reporter le dépassement
              <span className="block text-[11px] text-faint">Sinon il est retiré du mois suivant</span>
            </span>
            <Switch
              checked={category.carryover}
              label="Reporter le dépassement"
              onCheckedChange={(checked) => carry.mutate({ data: { month, categoryId: category.id, carryover: checked } })}
            />
          </label>
          <div className="mt-1 border-t border-line px-2 pb-1 pt-2 text-[11px] text-faint">
            Reporté du mois dernier <span className="num">{formatMoney(category.carryIn)}</span> · moyenne 3 mois{" "}
            <span className="num">{formatMoney(category.average3)}</span>
          </div>
        </div>
      </Popover>
      {mode ? <MoveMoneyDialog mode={mode} category={category} month={month} budget={budget} onClose={() => setMode(null)} /> : null}
    </>
  )
}

const MenuButton = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button type="button" onClick={onClick} className="rounded-[6px] px-2 py-1.5 text-left text-fg-2 hover:bg-hover hover:text-fg">
    {children}
  </button>
)

export function MoveMoneyDialog({
  mode,
  category,
  month,
  budget,
  onClose,
}: {
  mode: MoveMode
  category: BudgetCategoryRow
  month: string
  budget: BudgetMonthDto
  onClose: () => void
}) {
  const [other, setOther] = React.useState<MoveTarget | null>(null)
  const [amount, setAmount] = React.useState(
    mode === "cover" ? (category.available < 0 ? amountInput(-category.available) : "") : amountInput(category.available),
  )
  const available = new Map(budget.groups.flatMap((g) => g.categories.map((c) => [c.id, c.available] as const)))
  const move = useAction(moveBudget, { success: "Budget mis à jour", onSuccess: onClose, writes: ["budgets"] })
  const cents = parseAmount(amount)
  const fromToBudget = other?.kind === "toBudget"
  const submit = () => {
    if (cents === null || cents <= 0 || !other) return
    const self: MoveTarget = { kind: "category", id: category.id }
    move.mutate({ data: { month, from: mode === "cover" ? other : self, to: mode === "cover" ? self : other, amount: cents } })
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        mode === "transfer" ? `Transférer depuis ${category.name}` : category.available < 0 ? `Couvrir ${category.name}` : `Alimenter ${category.name}`
      }
      width={420}
      footer={
        <>
          <span />
          <div className="flex gap-2">
            <Button onClick={onClose}>Annuler</Button>
            <Button variant="primary" onClick={submit} disabled={!other || cents === null || cents <= 0} loading={move.isPending}>
              Valider
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Montant">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="num" inputMode="decimal" autoFocus />
        </Field>
        <Field label={mode === "cover" ? "Prendre dans" : "Vers"} group>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setOther({ kind: "toBudget" })}
              className={cx(
                "flex h-8 items-center justify-between rounded-[8px] border px-2.5",
                fromToBudget ? "border-accent-line bg-accent-soft" : "border-line-control",
              )}
            >
              <span>{mode === "cover" ? "À budgéter" : "Remettre dans « À budgéter »"}</span>
              <Money value={budget.toBudget} className="text-[12px] text-muted" />
            </button>
            <CategoryPicker
              value={other?.kind === "category" ? other.id : null}
              onChange={(id) => setOther(id ? { kind: "category", id } : null)}
              exclude={[category.id]}
              available={available}
              allowNone={false}
              placeholder="Une catégorie"
            />
          </div>
        </Field>
      </div>
    </Dialog>
  )
}

import { Link } from "@tanstack/react-router"
import { MoreHorizontal, Plus } from "lucide-react"
import * as React from "react"
import { useAppUi } from "~/components/shell"
import { cx, IconButton, Menu, revealOnHover, useReturnFocus } from "~/components/ui"
import { amountInput, formatMoney, parseAmount } from "~/domain/money"
import { count, plural } from "~/domain/text"
import { useAction } from "~/lib/queries"
import { fillBudget, setBudgetAmount } from "~/server/fns/core"
import type { BudgetCategoryRow, BudgetGroupRow, BudgetMonthDto } from "~/server/services/budget"
import { AvailableMenu } from "./move-money"
import { PlannedCell } from "./planned"
import { formatSpent } from "./spent"

const GRID = "grid grid-cols-[minmax(0,1fr)_140px_140px_140px_140px] max-lg:grid-cols-[minmax(0,1fr)_100px_110px_110px_120px]"

/** Where the budget editing goes after a cell: into it, out of it, or on to the next or previous editable cell. */
type EditStep = "open" | "close" | "next" | "prev"

export function BudgetTable({ budget, month, showHidden }: { budget: BudgetMonthDto; month: string; showHidden: boolean }) {
  const groups = budget.groups.filter((g) => showHidden || !g.hidden)
  const expenseGroups = groups.filter((g) => !g.isIncome)
  const incomeGroups = groups.filter((g) => g.isIncome)
  // Flat list of editable category ids, so Tab / Enter can move to the next row.
  const editable = expenseGroups.flatMap((g) => g.categories.filter((c) => showHidden || !c.hidden).map((c) => c.id))
  const [editing, setEditing] = React.useState<string | null>(null)
  const fill = useAction(fillBudget, { success: (n) => `${count(n, "catégorie")} ${plural(n, "mise")} à jour`, writes: ["budgets"] })
  const step = (id: string, next: EditStep) => {
    if (next === "open") setEditing(id)
    else if (next === "close") setEditing(null)
    else {
      const i = editable.indexOf(id)
      setEditing(editable[next === "next" ? i + 1 : i - 1] ?? null)
    }
  }

  return (
    <div role="table" aria-label="Budget du mois">
      <div role="row" className={cx(GRID, "h-[34px] items-center border-b border-line px-5 text-[12px] text-faint")}>
        <span role="columnheader" className="flex items-center gap-2">
          Catégorie
          <Menu
            align="start"
            trigger={
              <IconButton label="Remplir le budget" size="sm">
                <MoreHorizontal size={14} />
              </IconButton>
            }
            items={[
              { label: "Copier le budget du mois dernier", onSelect: () => fill.mutate({ data: { month, mode: { kind: "copyLastMonth" } } }) },
              { label: "Moyenne des 3 derniers mois", onSelect: () => fill.mutate({ data: { month, mode: { kind: "average", months: 3 } } }) },
              { label: "Moyenne des 6 derniers mois", onSelect: () => fill.mutate({ data: { month, mode: { kind: "average", months: 6 } } }) },
              { label: "Moyenne des 12 derniers mois", onSelect: () => fill.mutate({ data: { month, mode: { kind: "average", months: 12 } } }) },
              { label: "Budgéter ce qui a été dépensé", onSelect: () => fill.mutate({ data: { month, mode: { kind: "spent" } } }) },
              { label: "Budgéter les échéances", onSelect: () => fill.mutate({ data: { month, mode: { kind: "planned" } } }) },
              { separator: true },
              { label: "Tout remettre à zéro", danger: true, onSelect: () => fill.mutate({ data: { month, mode: { kind: "zero" } } }) },
            ]}
          />
        </span>
        <span role="columnheader" className="text-right">
          Prévu
        </span>
        <span role="columnheader" className="text-right">
          Budgété
        </span>
        <span role="columnheader" className="text-right">
          Dépensé
        </span>
        <span role="columnheader" className="text-right">
          Disponible
        </span>
      </div>
      {expenseGroups.map((g) => (
        <React.Fragment key={g.id}>
          <GroupRow group={g} />
          {g.categories
            .filter((c) => showHidden || !c.hidden)
            .map((c) => (
              <CategoryRow
                key={c.id}
                category={c}
                month={month}
                budget={budget}
                editing={editing === c.id}
                onEdit={(next) => step(c.id, next)}
              />
            ))}
        </React.Fragment>
      ))}
      {incomeGroups.map((g) => (
        <React.Fragment key={g.id}>
          <div role="row" className={cx(GRID, "h-[34px] items-center border-b border-line-subtle bg-row-group px-5 font-medium text-fg-2")}>
            <span>{g.name}</span>
            <span />
            <span />
            <span className="num text-right text-[12px] text-muted">Reçu</span>
            <span className="num text-right text-[12px]">{formatMoney(g.spent)}</span>
          </div>
          {g.categories
            .filter((c) => showHidden || !c.hidden)
            .map((c) => (
              <div key={c.id} role="row" className={cx(GRID, "h-9 items-center border-b border-line-subtle pl-9 pr-5 hover:bg-hover")}>
                <CategoryLink category={c} month={month} />
                <span />
                <span />
                <span />
                <span className="num text-right text-[12px] text-positive">{formatMoney(c.spent)}</span>
              </div>
            ))}
        </React.Fragment>
      ))}
    </div>
  )
}

function GroupRow({ group }: { group: BudgetGroupRow }) {
  return (
    <div
      role="row"
      className={cx(GRID, "h-[34px] items-center border-b border-line-subtle bg-row-group px-5 font-medium text-fg-2")}
    >
      <span className="truncate" title={group.name}>{group.name}</span>
      <span className="num text-right text-[12px] text-faint">{group.plannedTotal ? formatMoney(group.plannedTotal) : "—"}</span>
      <span className="num text-right text-[12px]">{formatMoney(group.budgeted)}</span>
      <span className="num text-right text-[12px] text-muted">{formatSpent(group.spent)}</span>
      <span className="num text-right text-[12px]">{formatMoney(group.available)}</span>
    </div>
  )
}

function CategoryLink({ category, month }: { category: BudgetCategoryRow; month: string }) {
  return (
    <Link
      to="/accounts/$accountId"
      params={{ accountId: "all" }}
      search={{ categoryId: category.id, month }}
      className={cx("truncate hover:underline", category.hidden && "text-faint")}
    >
      {category.name}
    </Link>
  )
}

function CategoryRow({
  category,
  month,
  budget,
  editing,
  onEdit,
}: {
  category: BudgetCategoryRow
  month: string
  budget: BudgetMonthDto
  editing: boolean
  onEdit: (next: EditStep) => void
}) {
  const { openNewTransaction } = useAppUi()
  return (
    <div
      role="row"
      data-testid={`category-row-${category.name}`}
      className={cx(GRID, "group h-9 items-center border-b border-line-subtle pl-9 pr-5 hover:bg-hover")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <CategoryLink category={category} month={month} />
        {category.carryover ? (
          <span className="text-[11px] text-faint" title="Le dépassement est reporté sur le mois suivant">
            ↻
          </span>
        ) : null}
        <button
          type="button"
          className={cx("text-faint hover:text-fg", revealOnHover)}
          aria-label={`Ajouter une opération dans ${category.name}`}
          onClick={() => openNewTransaction({ categoryId: category.id })}
        >
          <Plus size={13} />
        </button>
      </span>
      <PlannedCell category={category} month={month} />
      <BudgetedCell category={category} month={month} editing={editing} onEdit={onEdit} />
      <span className="num text-right text-[12px] text-muted">{formatSpent(category.spent)}</span>
      <span className="flex justify-end">
        <AvailableMenu category={category} month={month} budget={budget} />
      </span>
    </div>
  )
}

function BudgetedCell({
  category,
  month,
  editing,
  onEdit,
}: {
  category: BudgetCategoryRow
  month: string
  editing: boolean
  onEdit: (next: EditStep) => void
}) {
  const save = useAction(setBudgetAmount, { writes: ["budgets"] })
  const trigger = useReturnFocus<HTMLButtonElement>(editing)
  if (editing)
    return (
      <BudgetInput
        category={category}
        onCommit={(amount, then) => {
          if (amount !== null && amount !== category.budgeted) save.mutate({ data: { month, categoryId: category.id, amount } })
          onEdit(then)
        }}
      />
    )
  return (
    <button
      ref={trigger}
      type="button"
      onClick={() => onEdit("open")}
      aria-label={`Budget ${category.name} : ${formatMoney(category.budgeted)}`}
      className="num -mr-2 h-7 rounded-[6px] px-2 text-right text-[12px] text-fg-2 hover:bg-active"
    >
      {formatMoney(category.budgeted)}
    </button>
  )
}

// Mounted per edit so the text starts from the stored amount and is fully selected:
// typing replaces it instead of appending to it.
function BudgetInput({
  category,
  onCommit,
}: {
  category: BudgetCategoryRow
  /** `amount` is null when the edit is cancelled. */
  onCommit: (amount: number | null, then: Exclude<EditStep, "open">) => void
}) {
  const [text, setText] = React.useState(() => (category.budgeted ? amountInput(category.budgeted) : ""))
  const [invalid, setInvalid] = React.useState(false)
  // Leaving with Enter or Tab unmounts the input, which also fires blur.
  const done = React.useRef(false)

  const commit = (then: "next" | "prev") => {
    if (done.current) return
    const value = text.trim() === "" ? 0 : parseAmount(text)
    if (value === null) {
      setInvalid(true)
      return
    }
    done.current = true
    onCommit(value, then)
  }

  return (
    <input
      autoFocus
      inputMode="decimal"
      aria-label={`Budget ${category.name}`}
      aria-invalid={invalid || undefined}
      value={text}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        setText(e.target.value)
        setInvalid(false)
      }}
      onBlur={() => {
        if (done.current) return
        const value = text.trim() === "" ? 0 : parseAmount(text)
        done.current = true
        // An invalid amount is dropped on blur rather than trapping focus in the cell.
        onCommit(value, "close")
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          commit("next")
        } else if (e.key === "Tab") {
          e.preventDefault()
          commit(e.shiftKey ? "prev" : "next")
        } else if (e.key === "Escape") {
          e.preventDefault()
          done.current = true
          onCommit(null, "close")
        }
      }}
      className={cx(
        "num h-7 w-full rounded-[6px] border bg-bg px-2 text-right text-[12px] outline-none",
        invalid ? "border-negative" : "border-accent-line",
      )}
    />
  )
}

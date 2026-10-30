import { useNavigate } from "@tanstack/react-router"
import { ArrowLeftRight, Eye, EyeOff, List, Plus, Repeat } from "lucide-react"
import * as React from "react"
import { useAppUi } from "~/components/shell"
import type { MenuItem } from "~/components/ui"
import { count, plural } from "~/domain/text"
import { useAction } from "~/lib/queries"
import { fillBudget, setBudgetCarryover, updateCategory } from "~/server/fns/core"
import type { BudgetCategoryRow, BudgetMonthDto, FillMode } from "~/server/services/budget"
import { type MoveMode, MoveMoneyDialog } from "./move-money"

/** The actions on a budget category, shared by the desktop table and the mobile list. `dialogs` must be rendered by the caller. */
export function useCategoryActions(budget: BudgetMonthDto, month: string) {
  const fill = useAction(fillBudget, { success: (n) => `${count(n, "catégorie")} ${plural(n, "mise")} à jour`, writes: ["budgets"] })
  const carry = useAction(setBudgetCarryover, { writes: ["budgets"] })
  const hide = useAction(updateCategory, { writes: ["categories"] })
  const navigate = useNavigate()
  const { openNewTransaction } = useAppUi()
  const [moving, setMoving] = React.useState<{ categoryId: string; mode: MoveMode } | null>(null)
  const movingCategory = moving && budget.groups.flatMap((g) => g.categories).find((c) => c.id === moving.categoryId)

  const commonActions = (c: BudgetCategoryRow): { top: MenuItem[]; bottom: MenuItem[] } => ({
    top: [
      { label: "Ajouter une opération…", icon: <Plus size={13} />, onSelect: () => openNewTransaction({ categoryId: c.id }) },
      {
        label: "Voir les opérations",
        icon: <List size={13} />,
        onSelect: () => void navigate({ to: "/accounts/$accountId", params: { accountId: "all" }, search: { categoryId: c.id, month } }),
      },
    ],
    bottom: [
      {
        label: c.hidden ? "Afficher la catégorie" : "Masquer la catégorie",
        icon: c.hidden ? <Eye size={13} /> : <EyeOff size={13} />,
        onSelect: () => hide.mutate({ data: { id: c.id, hidden: !c.hidden } }),
      },
    ],
  })
  const expenseActions = (c: BudgetCategoryRow): MenuItem[] => {
    const { top, bottom } = commonActions(c)
    const fillOne = (mode: FillMode) => fill.mutate({ data: { month, mode, categoryIds: [c.id] } })
    return [
      ...top,
      { separator: true },
      // The server leaves hidden categories out of a fill.
      { label: "Copier le budget du mois dernier", onSelect: () => fillOne({ kind: "copyLastMonth" }), disabled: c.hidden },
      { label: "Moyenne des 3 derniers mois", onSelect: () => fillOne({ kind: "average", months: 3 }), disabled: c.hidden },
      { label: "Budgéter ce qui a été dépensé", onSelect: () => fillOne({ kind: "spent" }), disabled: c.hidden },
      { label: "Budgéter les échéances", onSelect: () => fillOne({ kind: "planned" }), disabled: c.hidden || !c.planned },
      { label: "Remettre à zéro", onSelect: () => fillOne({ kind: "zero" }), disabled: c.hidden || c.budgeted === 0 },
      { separator: true },
      {
        label: c.available < 0 ? "Couvrir le dépassement…" : "Prendre dans une autre catégorie…",
        icon: <ArrowLeftRight size={13} />,
        onSelect: () => setMoving({ categoryId: c.id, mode: "cover" }),
      },
      ...(c.available > 0
        ? [{ label: "Transférer vers une autre catégorie…", icon: <ArrowLeftRight size={13} />, onSelect: () => setMoving({ categoryId: c.id, mode: "transfer" }) }]
        : []),
      {
        label: c.carryover ? "Ne plus reporter le dépassement" : "Reporter le dépassement",
        icon: <Repeat size={13} />,
        onSelect: () => carry.mutate({ data: { month, categoryId: c.id, carryover: !c.carryover } }),
      },
      { separator: true },
      ...bottom,
    ]
  }
  const incomeActions = (c: BudgetCategoryRow): MenuItem[] => {
    const { top, bottom } = commonActions(c)
    return [...top, { separator: true }, ...bottom]
  }

  const dialogs =
    moving && movingCategory ? (
      <MoveMoneyDialog mode={moving.mode} category={movingCategory} month={month} budget={budget} onClose={() => setMoving(null)} />
    ) : null

  return { expenseActions, incomeActions, dialogs }
}

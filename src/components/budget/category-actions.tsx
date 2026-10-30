import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ArrowDown, ArrowLeftRight, ArrowUp, Eye, EyeOff, FolderPlus, List, Pencil, Plus, Repeat, Settings2, Trash2 } from "lucide-react"
import * as React from "react"
import { DeleteCategoriesDialog, EditCategoryDialog, NewCategoryDialog, NewGroupDialog, RenameGroupDialog } from "~/components/category-dialogs"
import { useAppUi } from "~/components/shell"
import type { MenuItem } from "~/components/ui"
import { count, plural } from "~/domain/text"
import { patchCategoryOrder, q, useAction } from "~/lib/queries"
import { deleteCategory, fillBudget, reorderCategories, setBudgetCarryover, updateCategory } from "~/server/fns/core"
import type { BudgetCategoryRow, BudgetGroupRow, BudgetMonthDto, FillMode } from "~/server/services/budget"
import { type MoveMode, MoveMoneyDialog } from "./move-money"

type Opened =
  | { kind: "move"; categoryId: string; mode: MoveMode }
  | { kind: "edit"; categoryId: string }
  | { kind: "delete"; categoryId: string }
  | { kind: "newCategory"; group: BudgetGroupRow }
  | { kind: "renameGroup"; group: BudgetGroupRow }
  | { kind: "newGroup" }

/**
 * The actions on a budget category or group, shared by the desktop table and the mobile list.
 * `dialogs` must be rendered by the caller.
 */
export function useCategoryActions(budget: BudgetMonthDto, month: string, showHidden: boolean) {
  const fill = useAction(fillBudget, { success: (n) => `${count(n, "catégorie")} ${plural(n, "mise")} à jour`, writes: ["budgets"] })
  const carry = useAction(setBudgetCarryover, { writes: ["budgets"] })
  const hide = useAction(updateCategory, { writes: ["categories"] })
  const reorder = useAction(reorderCategories, {
    scope: "reorder-categories",
    writes: ["categories"],
    optimistic: ({ data }, client) => patchCategoryOrder(client, data.order),
  })
  // The order sent to the server covers every group and category, hidden ones included.
  const tree = useQuery(q.categories()).data
  const navigate = useNavigate()
  const { openNewTransaction } = useAppUi()
  const [opened, setOpened] = React.useState<Opened | null>(null)
  const close = () => setOpened(null)
  const located = (id: string) => {
    for (const group of budget.groups) for (const category of group.categories) if (category.id === id) return { group, category }
    return null
  }

  /** The new order with `c` moved past its next shown neighbour, or null when it already comes first or last. */
  const orderAfterMove = (c: BudgetCategoryRow, delta: -1 | 1) => {
    const groups = tree?.map((g) => ({ groupId: g.id, categoryIds: g.categories.map((x) => x.id) }))
    const group = tree?.find((g) => g.categories.some((x) => x.id === c.id))
    const ids = groups?.find((g) => g.groupId === group?.id)?.categoryIds
    if (!groups || !group || !ids) return null
    const from = ids.indexOf(c.id)
    let to = from + delta
    while (to >= 0 && to < ids.length && !showHidden && group.categories[to]?.hidden) to += delta
    if (to < 0 || to >= ids.length) return null
    ids.splice(from, 1)
    ids.splice(to, 0, c.id)
    return groups
  }

  const manage = (c: BudgetCategoryRow): MenuItem => {
    const up = orderAfterMove(c, -1)
    const down = orderAfterMove(c, 1)
    return {
      label: "Gestion de la catégorie",
      icon: <Settings2 size={13} />,
      items: [
        { label: "Modifier…", icon: <Pencil size={13} />, onSelect: () => setOpened({ kind: "edit", categoryId: c.id }) },
        { label: "Monter", icon: <ArrowUp size={13} />, disabled: !up, onSelect: () => up && reorder.mutate({ data: { order: up } }) },
        { label: "Descendre", icon: <ArrowDown size={13} />, disabled: !down, onSelect: () => down && reorder.mutate({ data: { order: down } }) },
        { separator: true },
        {
          label: c.hidden ? "Afficher" : "Masquer",
          icon: c.hidden ? <Eye size={13} /> : <EyeOff size={13} />,
          onSelect: () => hide.mutate({ data: { id: c.id, hidden: !c.hidden } }),
        },
        { label: "Supprimer…", icon: <Trash2 size={13} />, danger: true, onSelect: () => setOpened({ kind: "delete", categoryId: c.id }) },
      ],
    }
  }

  const commonActions = (c: BudgetCategoryRow): { top: MenuItem[]; bottom: MenuItem[] } => ({
    top: [
      { label: "Ajouter une opération…", icon: <Plus size={13} />, onSelect: () => openNewTransaction({ categoryId: c.id }) },
      {
        label: "Voir les opérations",
        icon: <List size={13} />,
        onSelect: () => void navigate({ to: "/accounts/$accountId", params: { accountId: "all" }, search: { categoryId: c.id, month } }),
      },
    ],
    bottom: [manage(c)],
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
        onSelect: () => setOpened({ kind: "move", categoryId: c.id, mode: "cover" }),
      },
      ...(c.available > 0
        ? [{ label: "Transférer vers une autre catégorie…", icon: <ArrowLeftRight size={13} />, onSelect: () => setOpened({ kind: "move", categoryId: c.id, mode: "transfer" }) }]
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

  const groupActions = (g: BudgetGroupRow): MenuItem[] => [
    { label: "Ajouter une catégorie…", icon: <Plus size={13} />, onSelect: () => setOpened({ kind: "newCategory", group: g }) },
    { label: "Renommer le groupe…", icon: <Pencil size={13} />, onSelect: () => setOpened({ kind: "renameGroup", group: g }) },
    { separator: true },
    { label: "Nouveau groupe…", icon: <FolderPlus size={13} />, onSelect: () => setOpened({ kind: "newGroup" }) },
  ]

  const dialogs = (() => {
    if (!opened) return null
    if (opened.kind === "newGroup") return <NewGroupDialog onClose={close} />
    if (opened.kind === "newCategory") return <NewCategoryDialog group={opened.group} onClose={close} />
    if (opened.kind === "renameGroup") return <RenameGroupDialog group={opened.group} onClose={close} />
    const found = located(opened.categoryId)
    if (!found) return null
    const { group, category } = found
    if (opened.kind === "move")
      return <MoveMoneyDialog mode={opened.mode} category={category} month={month} budget={budget} onClose={close} />
    if (opened.kind === "edit")
      return <EditCategoryDialog category={{ ...category, groupId: group.id }} onClose={close} />
    return (
      <DeleteCategoriesDialog
        title={`Supprimer « ${category.name} »`}
        description="Choisis où transférer ses opérations et son budget, ou laisse-les sans catégorie."
        exclude={[category.id]}
        onConfirm={(reassignTo) => deleteCategory({ data: { id: category.id, reassignTo } })}
        onClose={close}
      />
    )
  })()

  return { expenseActions, incomeActions, groupActions, dialogs }
}

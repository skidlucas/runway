import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ArrowDown, ArrowUp, Eye, EyeOff, MoreHorizontal, Plus, Trash2 } from "lucide-react"
import * as React from "react"
import { DeleteCategoriesDialog, NewGroupDialog } from "~/components/category-dialogs"
import { PageHeader } from "~/components/shell"
import { Button, ContextMenu, cx, IconButton, InlineEdit, Input, Menu, type MenuItem, revealOnHover, SkeletonRows } from "~/components/ui"
import { q, useAction } from "~/lib/queries"
import {
  createCategory,
  deleteCategory,
  deleteCategoryGroup,
  reorderCategories,
  updateCategory,
  updateCategoryGroup,
} from "~/server/fns/core"
import type { CategoryDto, CategoryGroupDto } from "~/server/services/categories"

export const Route = createFileRoute("/_app/settings/categories")({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.categories()),
  component: CategoriesSettings,
})

function CategoriesSettings() {
  const categories = useQuery(q.categories())
  const [newGroup, setNewGroup] = React.useState(false)
  const client = useQueryClient()
  const reorder = useAction(reorderCategories, { scope: "reorder-categories", writes: ["categories"] })
  const tree = categories.data ?? []

  // Shown at once, so that a second click moves from the new position rather than the old one.
  const move = (groups: CategoryGroupDto[]) => {
    client.setQueryData(q.categories().queryKey, groups)
    reorder.mutate({ data: { order: groups.map((g) => ({ groupId: g.id, categoryIds: g.categories.map((c) => c.id) })) } })
  }

  const moveGroup = (index: number, delta: number) => {
    const next = [...tree]
    const [g] = next.splice(index, 1)
    if (!g) return
    next.splice(index + delta, 0, g)
    move(next)
  }
  const moveCategory = (groupIndex: number, catIndex: number, delta: number) => {
    const next = tree.map((g) => ({ ...g, categories: [...g.categories] }))
    const group = next[groupIndex]
    if (!group) return
    const [c] = group.categories.splice(catIndex, 1)
    if (!c) return
    group.categories.splice(catIndex + delta, 0, c)
    move(next)
  }

  return (
    <>
      <PageHeader
        title="Réglages"
        crumb="Catégories"
        right={
          <Button icon={<Plus size={14} />} onClick={() => setNewGroup(true)}>
            Nouveau groupe
          </Button>
        }
      />
      {!categories.data ? (
        <SkeletonRows />
      ) : (
        <div className="max-w-[860px]">
          {tree.map((g, gi) => (
            <section key={g.id}>
              <GroupRow
                group={g}
                canUp={gi > 0 && !g.isIncome && !tree[gi - 1]?.isIncome}
                canDown={gi < tree.length - 1 && !g.isIncome && !tree[gi + 1]?.isIncome}
                onMove={(d) => moveGroup(gi, d)}
              />
              {g.categories.map((c, ci) => (
                <CategoryRow
                  key={c.id}
                  category={c}
                  canUp={ci > 0}
                  canDown={ci < g.categories.length - 1}
                  onMove={(d) => moveCategory(gi, ci, d)}
                />
              ))}
              <AddCategory groupId={g.id} />
            </section>
          ))}
        </div>
      )}
      {newGroup ? <NewGroupDialog onClose={() => setNewGroup(false)} /> : null}
    </>
  )
}

const InlineName = ({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }) => (
  <InlineEdit
    value={value}
    label="Nom"
    onCommit={(name) => name.trim() && onSave(name)}
    className={cx("truncate text-left hover:underline", className)}
  >
    {value}
  </InlineEdit>
)

function GroupRow({
  group,
  canUp,
  canDown,
  onMove,
}: {
  group: CategoryGroupDto
  canUp: boolean
  canDown: boolean
  onMove: (delta: number) => void
}) {
  const update = useAction(updateCategoryGroup, { writes: ["categories"] })
  const [deleting, setDeleting] = React.useState(false)
  const actions: MenuItem[] = [
    {
      label: group.hidden ? "Afficher" : "Masquer",
      icon: group.hidden ? <Eye size={13} /> : <EyeOff size={13} />,
      onSelect: () => update.mutate({ data: { id: group.id, hidden: !group.hidden } }),
    },
    { label: "Supprimer…", danger: true, icon: <Trash2 size={13} />, onSelect: () => setDeleting(true) },
  ]
  return (
    <ContextMenu items={[...moveItems(canUp, canDown, onMove), { separator: true }, ...actions]}>
      <div className="group flex h-[34px] items-center gap-2 border-b border-line-subtle bg-row-group px-5 font-medium text-fg-2 data-[popup-open]:bg-hover">
        <InlineName value={group.name} onSave={(name) => update.mutate({ data: { id: group.id, name } })} />
        {group.isIncome ? <span className="text-[11px] font-normal text-faint">revenus</span> : null}
        {group.hidden ? <span className="text-[11px] font-normal text-faint">masqué</span> : null}
        <span className={cx("ml-auto flex items-center gap-1", revealOnHover)}>
          <IconButton label="Monter" size="sm" disabled={!canUp} onClick={() => onMove(-1)}>
            <ArrowUp size={13} />
          </IconButton>
          <IconButton label="Descendre" size="sm" disabled={!canDown} onClick={() => onMove(1)}>
            <ArrowDown size={13} />
          </IconButton>
          <Menu
            trigger={
              <IconButton label="Actions du groupe" size="sm">
                <MoreHorizontal size={13} />
              </IconButton>
            }
            items={actions}
          />
        </span>
        {deleting ? (
          <DeleteCategoriesDialog
            title={`Supprimer le groupe « ${group.name} »`}
            description={`Ses ${group.categories.length} catégories seront supprimées. Leurs opérations et budgets peuvent être transférés.`}
            exclude={group.categories.map((c) => c.id)}
            onConfirm={(reassignTo) => deleteCategoryGroup({ data: { id: group.id, reassignTo } })}
            onClose={() => setDeleting(false)}
          />
        ) : null}
      </div>
    </ContextMenu>
  )
}

const moveItems = (canUp: boolean, canDown: boolean, onMove: (delta: number) => void): MenuItem[] => [
  { label: "Monter", icon: <ArrowUp size={13} />, onSelect: () => onMove(-1), disabled: !canUp },
  { label: "Descendre", icon: <ArrowDown size={13} />, onSelect: () => onMove(1), disabled: !canDown },
]

function CategoryRow({
  category,
  canUp,
  canDown,
  onMove,
}: {
  category: CategoryDto
  canUp: boolean
  canDown: boolean
  onMove: (delta: number) => void
}) {
  const update = useAction(updateCategory, { writes: ["categories"] })
  const [deleting, setDeleting] = React.useState(false)
  return (
    <ContextMenu
      items={[
        ...moveItems(canUp, canDown, onMove),
        { separator: true },
        {
          label: category.hidden ? "Afficher" : "Masquer",
          icon: category.hidden ? <Eye size={13} /> : <EyeOff size={13} />,
          onSelect: () => update.mutate({ data: { id: category.id, hidden: !category.hidden } }),
        },
        { label: "Supprimer…", danger: true, icon: <Trash2 size={13} />, onSelect: () => setDeleting(true) },
      ]}
    >
      <div data-testid="category-settings-row" className="group flex h-9 items-center gap-2 border-b border-line-subtle pl-9 pr-5 hover:bg-hover data-[popup-open]:bg-hover">
        <InlineName
          value={category.name}
          className={category.hidden ? "text-faint" : ""}
          onSave={(name) => update.mutate({ data: { id: category.id, name } })}
        />
        {category.hidden ? <span className="text-[11px] text-faint">masquée</span> : null}
        <span className={cx("ml-auto flex items-center gap-1", revealOnHover)}>
          <IconButton label="Monter" size="sm" disabled={!canUp} onClick={() => onMove(-1)}>
            <ArrowUp size={13} />
          </IconButton>
          <IconButton label="Descendre" size="sm" disabled={!canDown} onClick={() => onMove(1)}>
            <ArrowDown size={13} />
          </IconButton>
          <IconButton
            label={category.hidden ? "Afficher" : "Masquer"}
            size="sm"
            onClick={() => update.mutate({ data: { id: category.id, hidden: !category.hidden } })}
          >
            {category.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
          </IconButton>
          <IconButton label="Supprimer" size="sm" onClick={() => setDeleting(true)}>
            <Trash2 size={13} />
          </IconButton>
        </span>
        {deleting ? (
          <DeleteCategoriesDialog
            title={`Supprimer « ${category.name} »`}
            description="Choisis où transférer ses opérations et son budget, ou laisse-les sans catégorie."
            exclude={[category.id]}
            onConfirm={(reassignTo) => deleteCategory({ data: { id: category.id, reassignTo } })}
            onClose={() => setDeleting(false)}
          />
        ) : null}
      </div>
    </ContextMenu>
  )
}

function AddCategory({ groupId }: { groupId: string }) {
  const [name, setName] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const create = useAction(createCategory, { onSuccess: () => setName(""), writes: ["categories"] })
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full items-center gap-1.5 border-b border-line-subtle pl-9 text-[12px] text-faint hover:text-fg"
      >
        <Plus size={12} /> Ajouter une catégorie
      </button>
    )
  }
  return (
    <form
      className="flex h-9 items-center gap-2 border-b border-line-subtle pl-9 pr-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) create.mutate({ data: { groupId, name } })
      }}
    >
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de la catégorie" className="h-7 max-w-[280px]" />
      <Button size="sm" type="submit" variant="primary" loading={create.isPending}>
        Ajouter
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Fermer
      </Button>
    </form>
  )
}

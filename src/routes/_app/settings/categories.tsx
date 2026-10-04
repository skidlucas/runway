import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ArrowDown, ArrowUp, Eye, EyeOff, MoreHorizontal, Plus, Trash2 } from "lucide-react"
import * as React from "react"
import { CategoryPicker } from "~/components/pickers"
import { PageHeader } from "~/components/shell"
import { Button, ConfirmDialog, cx, Dialog, Field, IconButton, Input, Menu, revealOnHover, SkeletonRows } from "~/components/ui"
import { q, useAction } from "~/lib/queries"
import {
  createCategory,
  createCategoryGroup,
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
  const reorder = useAction(reorderCategories, { scope: "reorder-categories" })
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

function InlineName({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }) {
  const [editing, setEditing] = React.useState(false)
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={value}
        aria-label="Nom"
        onBlur={(e) => {
          setEditing(false)
          if (e.target.value.trim() && e.target.value !== value) onSave(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "Escape") setEditing(false)
        }}
        className="h-7 rounded-[6px] border border-accent-line bg-bg px-2 outline-none"
      />
    )
  }
  return (
    <button type="button" onClick={() => setEditing(true)} className={cx("truncate text-left hover:underline", className)}>
      {value}
    </button>
  )
}

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
  const update = useAction(updateCategoryGroup)
  const [deleting, setDeleting] = React.useState(false)
  return (
    <div className="group flex h-[34px] items-center gap-2 border-b border-line-subtle bg-row-group px-5 font-medium text-fg-2">
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
          items={[
            {
              label: group.hidden ? "Afficher" : "Masquer",
              icon: group.hidden ? <Eye size={13} /> : <EyeOff size={13} />,
              onSelect: () => update.mutate({ data: { id: group.id, hidden: !group.hidden } }),
            },
            { label: "Supprimer…", danger: true, icon: <Trash2 size={13} />, onSelect: () => setDeleting(true) },
          ]}
        />
      </span>
      {deleting ? (
        <DeleteDialog
          title={`Supprimer le groupe « ${group.name} »`}
          description={`Ses ${group.categories.length} catégories seront supprimées. Leurs opérations et budgets peuvent être transférés.`}
          exclude={group.categories.map((c) => c.id)}
          onConfirm={(reassignTo) => deleteCategoryGroup({ data: { id: group.id, reassignTo } })}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </div>
  )
}

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
  const update = useAction(updateCategory)
  const [deleting, setDeleting] = React.useState(false)
  return (
    <div className="group flex h-9 items-center gap-2 border-b border-line-subtle pl-9 pr-5 hover:bg-hover">
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
        <DeleteDialog
          title={`Supprimer « ${category.name} »`}
          description="Choisis où transférer ses opérations et son budget, ou laisse-les sans catégorie."
          exclude={[category.id]}
          onConfirm={(reassignTo) => deleteCategory({ data: { id: category.id, reassignTo } })}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </div>
  )
}

function DeleteDialog({
  title,
  description,
  exclude,
  onConfirm,
  onClose,
}: {
  title: string
  description: string
  exclude: string[]
  onConfirm: (reassignTo: string | null) => Promise<unknown>
  onClose: () => void
}) {
  const [target, setTarget] = React.useState<string | null>(null)
  const run = useAction((reassignTo: string | null) => onConfirm(reassignTo), { success: "Supprimé", onSuccess: onClose })
  return (
    <ConfirmDialog
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      pending={run.isPending}
      onConfirm={() => run.mutate(target)}
    >
      <div className="px-5 py-4">
        <Field label="Transférer vers">
          <CategoryPicker value={target} onChange={setTarget} exclude={exclude} placeholder="Aucune (laisser sans catégorie)" />
        </Field>
      </div>
    </ConfirmDialog>
  )
}

function AddCategory({ groupId }: { groupId: string }) {
  const [name, setName] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const create = useAction(createCategory, { onSuccess: () => setName("") })
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

function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = React.useState("")
  const create = useAction(createCategoryGroup, { success: "Groupe créé", onSuccess: onClose })
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Nouveau groupe"
      width={400}
      footer={
        <>
          <span />
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate({ data: { name } })}>
            Créer
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        <Field label="Nom">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  )
}

import { useQuery } from "@tanstack/react-query"
import * as React from "react"
import { CategoryPicker } from "~/components/pickers"
import { Button, ConfirmDialog, Dialog, Field, Input, Select } from "~/components/ui"
import { q, useAction } from "~/lib/queries"
import { createCategory, createCategoryGroup, updateCategory, updateCategoryGroup } from "~/server/fns/core"

/** Deletes categories (or a group of them) after picking where their operations, budgets and rules go. */
export function DeleteCategoriesDialog({
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
  const run = useAction((reassignTo: string | null) => onConfirm(reassignTo), {
    success: "Supprimé",
    onSuccess: onClose,
    // Operations, schedules, budgets, rules and saved views move to the replacement.
    writes: ["categories", "transactionCategories", "schedules", "budgets", "rules", "savedViews"],
  })
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

function NameDialog({
  title,
  initial = "",
  action,
  pending,
  onSubmit,
  onClose,
}: {
  title: string
  initial?: string
  action: string
  pending: boolean
  onSubmit: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = React.useState(initial)
  const submit = () => name.trim() && onSubmit(name)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      width={400}
      footer={
        <>
          <span />
          <Button variant="primary" disabled={!name.trim()} loading={pending} onClick={submit}>
            {action}
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        <Field label="Nom">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
      </div>
    </Dialog>
  )
}

export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const create = useAction(createCategoryGroup, { success: "Groupe créé", onSuccess: onClose, writes: ["categories"] })
  return (
    <NameDialog title="Nouveau groupe" action="Créer" pending={create.isPending} onSubmit={(name) => create.mutate({ data: { name } })} onClose={onClose} />
  )
}

export function RenameGroupDialog({ group, onClose }: { group: { id: string; name: string }; onClose: () => void }) {
  const update = useAction(updateCategoryGroup, { onSuccess: onClose, writes: ["categories"] })
  return (
    <NameDialog
      title="Renommer le groupe"
      initial={group.name}
      action="Enregistrer"
      pending={update.isPending}
      onSubmit={(name) => update.mutate({ data: { id: group.id, name } })}
      onClose={onClose}
    />
  )
}

export function NewCategoryDialog({ group, onClose }: { group: { id: string; name: string }; onClose: () => void }) {
  const create = useAction(createCategory, { success: "Catégorie créée", onSuccess: onClose, writes: ["categories"] })
  return (
    <NameDialog
      title={`Nouvelle catégorie dans ${group.name}`}
      action="Créer"
      pending={create.isPending}
      onSubmit={(name) => create.mutate({ data: { groupId: group.id, name } })}
      onClose={onClose}
    />
  )
}

/** Renames a category or moves it to another group of the same kind (expenses or income). */
export function EditCategoryDialog({
  category,
  onClose,
}: {
  category: { id: string; name: string; groupId: string; isIncome: boolean }
  onClose: () => void
}) {
  const [name, setName] = React.useState(category.name)
  const [groupId, setGroupId] = React.useState(category.groupId)
  const groups = useQuery(q.categories()).data?.filter((g) => g.isIncome === category.isIncome) ?? []
  const update = useAction(updateCategory, { onSuccess: onClose, writes: ["categories"] })
  const submit = () => {
    if (!name.trim()) return
    update.mutate({
      data: {
        id: category.id,
        ...(name !== category.name ? { name } : {}),
        ...(groupId !== category.groupId ? { groupId } : {}),
      },
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Modifier la catégorie"
      width={400}
      footer={
        <>
          <span />
          <Button variant="primary" disabled={!name.trim()} loading={update.isPending} onClick={submit}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <Field label="Nom">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
        <Field label="Groupe">
          <Select value={groupId} onChange={setGroupId} options={groups.map((g) => ({ value: g.id, label: g.name }))} aria-label="Groupe" />
        </Field>
      </div>
    </Dialog>
  )
}

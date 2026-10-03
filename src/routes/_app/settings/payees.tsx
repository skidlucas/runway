import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Search } from "lucide-react"
import * as React from "react"
import { PageHeader } from "~/components/shell"
import { Button, Checkbox, Dialog, Field, Input, Select, SkeletonRows } from "~/components/ui"
import { formatDayShort } from "~/domain/dates"
import { normalizeText } from "~/domain/rules"
import { q, useAction } from "~/lib/queries"
import { deleteUnusedPayees, mergePayees, renamePayee } from "~/server/fns/core"
import { count, plural } from "~/domain/text"

export const Route = createFileRoute("/_app/settings/payees")({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.payees()),
  component: PayeesSettings,
})

function PayeesSettings() {
  const payees = useQuery(q.payees())
  const categories = useQuery(q.categories())
  const [filter, setFilter] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [merging, setMerging] = React.useState(false)
  const cleanup = useAction(deleteUnusedPayees, { success: (n) => `${count(n, "bénéficiaire")} ${plural(n, "supprimé")}` })
  const catName = new Map((categories.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)))
  const list = (payees.data ?? []).filter((p) => !p.transferAccountId && normalizeText(p.name).includes(normalizeText(filter)))

  return (
    <>
      <PageHeader
        title="Réglages"
        crumb="Bénéficiaires"
        right={
          <>
            {selected.size >= 2 ? (
              <Button variant="primary" onClick={() => setMerging(true)}>
                Fusionner {selected.size} bénéficiaires
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => window.confirm("Supprimer les bénéficiaires sans opération, règle ni échéance ?") && cleanup.mutate(undefined)} loading={cleanup.isPending}>
              Supprimer les inutilisés
            </Button>
          </>
        }
      />
      <div className="relative mx-5 my-3 w-[300px] max-md:w-auto">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer" className="pl-8" />
      </div>
      {!payees.data ? (
        <SkeletonRows />
      ) : (
        <div>
          <div className="grid h-[34px] grid-cols-[20px_minmax(0,1fr)_minmax(0,1fr)_90px_90px] items-center gap-3 border-y border-line px-5 text-[12px] text-faint max-md:grid-cols-[20px_minmax(0,1fr)_70px]">
            <span />
            <span>Nom</span>
            <span className="max-md:hidden">Catégorie habituelle</span>
            <span className="text-right">Opérations</span>
            <span className="text-right max-md:hidden">Dernière</span>
          </div>
          {list.map((p) => (
            <div
              key={p.id}
              className="grid h-9 grid-cols-[20px_minmax(0,1fr)_minmax(0,1fr)_90px_90px] items-center gap-3 border-b border-line-subtle px-5 hover:bg-hover max-md:grid-cols-[20px_minmax(0,1fr)_70px]"
            >
              <Checkbox
                checked={selected.has(p.id)}
                label={`Sélectionner ${p.name}`}
                onCheckedChange={(c) =>
                  setSelected((s) => {
                    const n = new Set(s)
                    if (c) n.add(p.id)
                    else n.delete(p.id)
                    return n
                  })
                }
              />
              <PayeeName id={p.id} name={p.name} />
              <span className="truncate text-muted max-md:hidden">{p.lastCategoryId ? catName.get(p.lastCategoryId) : "—"}</span>
              <Link to="/accounts/$accountId" params={{ accountId: "all" }} search={{ q: p.name }} className="num text-right text-[12px] text-muted hover:text-fg">
                {p.transactionCount}
              </Link>
              <span className="num text-right text-[12px] text-faint max-md:hidden">{p.lastUsed ? formatDayShort(p.lastUsed) : "—"}</span>
            </div>
          ))}
        </div>
      )}
      {merging ? (
        <MergeDialog
          options={(payees.data ?? []).filter((p) => selected.has(p.id))}
          onClose={(done) => {
            setMerging(false)
            if (done) setSelected(new Set())
          }}
        />
      ) : null}
    </>
  )
}

function PayeeName({ id, name }: { id: string; name: string }) {
  const [editing, setEditing] = React.useState(false)
  const rename = useAction(renamePayee)
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={name}
        aria-label="Nom du bénéficiaire"
        onBlur={(e) => {
          setEditing(false)
          if (e.target.value.trim() && e.target.value !== name) rename.mutate({ data: { id, name: e.target.value } })
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
    <button type="button" onClick={() => setEditing(true)} className="truncate text-left hover:underline">
      {name}
    </button>
  )
}

function MergeDialog({
  options,
  onClose,
}: {
  options: Array<{ id: string; name: string; transactionCount: number }>
  onClose: (done: boolean) => void
}) {
  const sorted = [...options].sort((a, b) => b.transactionCount - a.transactionCount)
  const [target, setTarget] = React.useState(sorted[0]?.id ?? "")
  const merge = useAction(mergePayees, { success: "Bénéficiaires fusionnés", onSuccess: () => onClose(true) })
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose(false)}
      title="Fusionner des bénéficiaires"
      description="Toutes les opérations, échéances et règles pointeront vers le bénéficiaire conservé."
      width={420}
      footer={
        <>
          <span />
          <Button
            variant="primary"
            loading={merge.isPending}
            onClick={() => merge.mutate({ data: { sourceIds: options.map((o) => o.id), targetId: target } })}
          >
            Fusionner
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        <Field label="Conserver">
          <Select
            value={target}
            onChange={setTarget}
            options={sorted.map((o) => ({ value: o.id, label: `${o.name} (${o.transactionCount})` }))}
          />
        </Field>
      </div>
    </Dialog>
  )
}

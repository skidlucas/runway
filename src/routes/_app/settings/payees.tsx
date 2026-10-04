import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import * as React from "react"
import { PageHeader } from "~/components/shell"
import { Button, Checkbox, Dialog, Field, InlineEdit, SearchInput, Select, SkeletonRows, useConfirm } from "~/components/ui"
import { formatDayShort } from "~/domain/dates"
import { normalizeText } from "~/domain/rules"
import { q, useAction } from "~/lib/queries"
import { useWindowList } from "~/lib/use-window-list"
import { deleteUnusedPayees, mergePayees, renamePayee } from "~/server/fns/core"
import type { PayeeDto } from "~/server/services/payees"
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
  const { confirm, dialog: confirmDialog } = useConfirm()
  const cleanup = useAction(deleteUnusedPayees, { success: (n) => `${count(n, "bénéficiaire")} ${plural(n, "supprimé")}` })
  const catName = React.useMemo(
    () => new Map((categories.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name] as const))),
    [categories.data],
  )
  const indexed = React.useMemo(
    () => (payees.data ?? []).filter((p) => !p.transferAccountId).map((p) => ({ payee: p, key: normalizeText(p.name) })),
    [payees.data],
  )
  const deferredFilter = React.useDeferredValue(filter)
  const list = React.useMemo(() => {
    const needle = normalizeText(deferredFilter)
    return indexed.filter((p) => p.key.includes(needle)).map((p) => p.payee)
  }, [indexed, deferredFilter])
  // Only what is on screen gets merged: the selection survives filtering and cleanups.
  const chosen = list.filter((p) => selected.has(p.id))
  const toggle = React.useCallback(
    (id: string, checked: boolean) =>
      setSelected((s) => {
        const n = new Set(s)
        if (checked) n.add(id)
        else n.delete(id)
        return n
      }),
    [],
  )

  return (
    <>
      <PageHeader
        title="Réglages"
        crumb="Bénéficiaires"
        right={
          <>
            {chosen.length >= 2 ? (
              <Button variant="primary" onClick={() => setMerging(true)}>
                Fusionner {chosen.length} bénéficiaires
              </Button>
            ) : null}
            <Button variant="ghost" onClick={async () => (await confirm({ title: "Supprimer les bénéficiaires sans opération, règle ni échéance ?" })) && cleanup.mutate(undefined)} loading={cleanup.isPending}>
              Supprimer les inutilisés
            </Button>
          </>
        }
      />
      <SearchInput
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filtrer"
        aria-label="Filtrer les bénéficiaires"
        wrapperClassName="mx-5 my-3 w-[300px] max-md:w-auto"
      />
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
          <PayeeRows list={list} selected={selected} onToggle={toggle} catName={catName} />
        </div>
      )}
      {merging ? (
        <MergeDialog
          options={chosen}
          onClose={(done) => {
            setMerging(false)
            if (done) setSelected(new Set())
          }}
        />
      ) : null}
      {confirmDialog}
    </>
  )
}

const ROW_HEIGHT = 36

function PayeeRows({
  list,
  selected,
  onToggle,
  catName,
}: {
  list: PayeeDto[]
  selected: Set<string>
  onToggle: (id: string, checked: boolean) => void
  catName: Map<string, string>
}) {
  const rows = useWindowList({ count: list.length, estimateSize: () => ROW_HEIGHT, getItemKey: (i) => list[i]?.id ?? String(i) })
  return (
    <div ref={rows.ref} className="relative" style={{ height: rows.virtualizer.getTotalSize() }}>
      {rows.items.map((item) => {
        const p = list[item.index]
        if (!p) return null
        return (
          <PayeeLine
            key={p.id}
            payee={p}
            top={rows.offset(item)}
            selected={selected.has(p.id)}
            onToggle={onToggle}
            categoryName={p.lastCategoryId ? catName.get(p.lastCategoryId) : undefined}
          />
        )
      })}
    </div>
  )
}

const PayeeLine = React.memo(function PayeeLine({
  payee: p,
  top,
  selected,
  onToggle,
  categoryName,
}: {
  payee: PayeeDto
  top: number
  selected: boolean
  onToggle: (id: string, checked: boolean) => void
  categoryName: string | undefined
}) {
  return (
    <div
      className="absolute inset-x-0 top-0 grid h-9 grid-cols-[20px_minmax(0,1fr)_minmax(0,1fr)_90px_90px] items-center gap-3 border-b border-line-subtle px-5 hover:bg-hover max-md:grid-cols-[20px_minmax(0,1fr)_70px]"
      style={{ transform: `translateY(${top}px)` }}
    >
      <Checkbox checked={selected} label={`Sélectionner ${p.name}`} onCheckedChange={(c) => onToggle(p.id, c)} />
      <PayeeName id={p.id} name={p.name} />
      <span className="truncate text-muted max-md:hidden">{categoryName ?? "—"}</span>
      <Link to="/accounts/$accountId" params={{ accountId: "all" }} search={{ q: p.name }} className="num text-right text-[12px] text-muted hover:text-fg">
        {p.transactionCount}
      </Link>
      <span className="num text-right text-[12px] text-faint max-md:hidden">{p.lastUsed ? formatDayShort(p.lastUsed) : "—"}</span>
    </div>
  )
})

function PayeeName({ id, name }: { id: string; name: string }) {
  const rename = useAction(renamePayee)
  return (
    <InlineEdit
      value={name}
      label="Nom du bénéficiaire"
      onCommit={(next) => next.trim() && rename.mutate({ data: { id, name: next } })}
      className="truncate text-left hover:underline"
    >
      {name}
    </InlineEdit>
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

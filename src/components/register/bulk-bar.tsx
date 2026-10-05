import { Trash2 } from "lucide-react"
import { CategoryPicker } from "~/components/pickers"
import { useDeleteTransactions } from "~/components/transaction-editor"
import { Button } from "~/components/ui"
import { count } from "~/domain/text"
import { useAction } from "~/lib/queries"
import { setTransactionsCategory, setTransactionsCleared } from "~/server/fns/core"
import type { TxRow } from "~/server/services/transactions"

export function BulkBar({ ids, rows, onDone }: { ids: string[]; rows: TxRow[]; onDone: () => void }) {
  const setCategory = useAction(setTransactionsCategory, { success: "Catégorie appliquée", onSuccess: onDone, writes: ["transactionCategories"] })
  const setCleared = useAction(setTransactionsCleared, { onSuccess: onDone, writes: ["cleared"] })
  const remove = useDeleteTransactions(onDone)
  const chosen = new Set(ids)
  const allCleared = rows.filter((r) => chosen.has(r.id)).every((r) => r.cleared)
  return (
    <div className="sticky top-12 z-20 flex items-center gap-2 border-b border-line bg-accent-soft px-5 py-2">
      <span className="font-medium">{count(ids.length, "sélectionnée")}</span>
      <CategoryPicker
        value={null}
        onChange={(categoryId) => setCategory.mutate({ data: { ids, categoryId } })}
        placeholder="Catégoriser…"
        className="w-[200px]"
      />
      <Button size="sm" onClick={() => setCleared.mutate({ data: { ids, cleared: !allCleared } })}>
        {allCleared ? "Dépointer" : "Pointer"}
      </Button>
      <Button
        size="sm"
        variant="danger"
        icon={<Trash2 size={13} />}
        onClick={() => remove.mutate(ids)}
      >
        Supprimer
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone} className="ml-auto">
        Annuler
      </Button>
    </div>
  )
}

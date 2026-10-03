import { useMutation, useQuery } from "@tanstack/react-query"
import { Check, Sparkles, X } from "lucide-react"
import * as React from "react"
import { toast, toastError } from "~/components/toast"
import { RuleFromTransactionDialog } from "~/components/transaction-editor"
import { Button, cx } from "~/components/ui"
import { q, useAction } from "~/lib/queries"
import { setTransactionsCategory } from "~/server/fns/core"
import { suggestCategories } from "~/server/fns/insights"
import type { CategorySuggestion } from "~/server/services/categorize"
import type { TxRow } from "~/server/services/transactions"

const CONFIDENT = 0.8

type RuleDraft = Pick<TxRow, "payeeName" | "importedPayee" | "categoryId">

type SuggestionsState = {
  byTx: ReadonlyMap<string, CategorySuggestion>
  names: ReadonlyMap<string, string>
  accept: (suggestions: ReadonlyArray<CategorySuggestion>) => void
  dismiss: (transactionId: string) => void
}

const SuggestionsContext = React.createContext<SuggestionsState | null>(null)

const needsCategory = (tx: TxRow) => !tx.categoryId && !tx.transferAccountId && !tx.isParent

/**
 * Category suggestions for the uncategorized rows on screen. Nothing is written until the user
 * accepts, one row at a time or every confident suggestion at once.
 */
export function useCategorySuggestions(rows: ReadonlyArray<TxRow>) {
  const ai = useQuery(q.aiStatus())
  const categories = useQuery(q.categories())
  const [byTx, setByTx] = React.useState<Map<string, CategorySuggestion>>(new Map())
  const [ruleDraft, setRuleDraft] = React.useState<RuleDraft | null>(null)
  const candidates = rows.filter(needsCategory)

  const suggest = useMutation({
    mutationFn: () => suggestCategories({ data: { ids: candidates.map((r) => r.id) } }),
    onSuccess: (result) => {
      setByTx(new Map(result.suggestions.map((s) => [s.transactionId, s])))
      if (result.suggestions.length === 0) toast("Aucune suggestion pour ces opérations.")
    },
    onError: toastError,
  })

  // Grouped by category so that accepting 300 rows is a handful of bulk updates, not 300 calls.
  const accept = useAction(
    async (suggestions: ReadonlyArray<CategorySuggestion>) => {
      const groups = new Map<string, string[]>()
      for (const s of suggestions) groups.set(s.categoryId, [...(groups.get(s.categoryId) ?? []), s.transactionId])
      for (const [categoryId, ids] of groups) await setTransactionsCategory({ data: { ids, categoryId } })
      return suggestions
    },
    {
      onSuccess: (accepted) => {
        if (accepted.length < 2) return
        const draft = ruleCandidate(accepted, rows)
        toast(`${accepted.length} opérations catégorisées`, {
          duration: draft ? 8000 : 3500,
          ...(draft
            ? { action: { label: `Règle pour « ${draft.payeeName ?? draft.importedPayee} »`, run: () => setRuleDraft(draft) } }
            : {}),
        })
      },
    },
  )

  const names = React.useMemo(
    () => new Map((categories.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name] as const))),
    [categories.data],
  )

  const pending = candidates.flatMap((r) => byTx.get(r.id) ?? [])
  const state: SuggestionsState & { ruleDraft: RuleDraft | null; closeRule: () => void } = {
    byTx,
    ruleDraft,
    closeRule: () => setRuleDraft(null),
    names,
    accept: (s) => accept.mutate(s),
    dismiss: (id) =>
      setByTx((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      }),
  }

  return {
    available: Boolean(ai.data?.classification) && candidates.length > 0,
    state,
    pending,
    suggest,
    accepting: accept.isPending,
    clear: () => setByTx(new Map()),
  }
}

export function SuggestButton({ s }: { s: ReturnType<typeof useCategorySuggestions> }) {
  if (!s.available || s.pending.length > 0) return null
  return (
    <Button size="sm" icon={<Sparkles size={13} />} loading={s.suggest.isPending} onClick={() => s.suggest.mutate()}>
      Suggérer des catégories
    </Button>
  )
}

export function SuggestionsBar({ s }: { s: ReturnType<typeof useCategorySuggestions> }) {
  if (s.pending.length === 0) return null
  const confident = s.pending.filter((p) => p.confidence >= CONFIDENT)
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-5 py-2">
      <Sparkles size={13} className="text-accent" />
      <span>
        {s.pending.length} suggestion{s.pending.length > 1 ? "s" : ""}
        <span className="text-muted"> · relis-les dans la colonne Catégorie</span>
      </span>
      <Button
        size="sm"
        variant="primary"
        className="ml-auto"
        disabled={confident.length === 0}
        loading={s.accepting}
        onClick={() => s.state.accept(confident)}
      >
        Accepter ≥ {CONFIDENT * 100} % ({confident.length})
      </Button>
      <Button size="sm" variant="ghost" onClick={s.clear}>
        Ignorer
      </Button>
    </div>
  )
}

export function SuggestionsProvider({ s, children }: { s: ReturnType<typeof useCategorySuggestions>; children: React.ReactNode }) {
  return (
    <SuggestionsContext.Provider value={s.state}>
      {children}
      {s.state.ruleDraft ? <RuleFromTransactionDialog tx={s.state.ruleDraft} onClose={s.state.closeRule} /> : null}
    </SuggestionsContext.Provider>
  )
}

/**
 * The payee that most accepted suggestions share, when they all agree on one category:
 * that agreement is what makes a payee → category rule worth proposing.
 */
const ruleCandidate = (accepted: ReadonlyArray<CategorySuggestion>, rows: ReadonlyArray<TxRow>): RuleDraft | null => {
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const byPayee = new Map<string, { row: TxRow; categories: Set<string>; count: number }>()
  for (const s of accepted) {
    const row = rowById.get(s.transactionId)
    const key = row?.payeeName ?? row?.importedPayee
    if (!row || !key) continue
    const entry = byPayee.get(key) ?? { row, categories: new Set<string>(), count: 0 }
    entry.categories.add(s.categoryId)
    entry.count++
    byPayee.set(key, entry)
  }
  const best = [...byPayee.values()]
    .filter((e) => e.categories.size === 1 && e.count >= 2)
    .sort((a, b) => b.count - a.count)[0]
  return best ? { payeeName: best.row.payeeName, importedPayee: best.row.importedPayee, categoryId: [...best.categories][0]! } : null
}

/** Inline proposal next to an uncategorized row; renders nothing when there is none. */
export function SuggestionChip({ tx, compact }: { tx: TxRow; compact?: boolean }) {
  const ctx = React.useContext(SuggestionsContext)
  const suggestion = ctx && needsCategory(tx) ? ctx.byTx.get(tx.id) : undefined
  if (!ctx || !suggestion) return null
  const name = ctx.names.get(suggestion.categoryId) ?? "?"
  const percent = Math.round(suggestion.confidence * 100)
  return (
    <span
      data-testid="category-suggestion"
      className={cx(
        "flex shrink-0 items-center overflow-hidden rounded-[5px] border border-dashed border-accent-line text-[12px]",
        compact && "max-w-[60%]",
      )}
    >
      <button
        type="button"
        title={`Accepter « ${name} » (confiance ${percent} %)`}
        onClick={(e) => {
          e.stopPropagation()
          ctx.accept([suggestion])
        }}
        className="flex min-w-0 items-center gap-1 px-1.5 py-0.5 text-accent-fg hover:bg-accent-soft"
      >
        <Check size={11} className="shrink-0" />
        <span className="truncate">{name}</span>
        <span className={cx("num", percent >= CONFIDENT * 100 ? "text-accent-fg" : "text-faint")}>{percent} %</span>
      </button>
      <button
        type="button"
        aria-label="Rejeter la suggestion"
        onClick={(e) => {
          e.stopPropagation()
          ctx.dismiss(tx.id)
        }}
        className="border-l border-dashed border-accent-line px-1 py-0.5 text-faint hover:text-fg"
      >
        <X size={11} />
      </button>
    </span>
  )
}

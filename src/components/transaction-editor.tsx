import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import * as React from "react"
import { amountInput, formatMoney, parseAmount } from "~/domain/money"
import { q, refreshAfter, useAction } from "~/lib/queries"
import { createRule, deleteTransactions, restoreTransactions, updateTransaction } from "~/server/fns/core"
import type { TxRow } from "~/server/services/transactions"
import { AccountSelect, CategoryPicker, PayeePicker, type PayeeValue } from "./pickers"
import { toast, toastError } from "./toast"
import { Button, Checkbox, cx, DateInput, Dialog, Field, IconButton, Input, Select, Switch } from "./ui"
import { count, plural } from "~/domain/text"

export const payeeValueOf = (tx: Pick<TxRow, "payeeId" | "payeeName" | "transferAccountId">): PayeeValue =>
  tx.transferAccountId
    ? { kind: "transfer", accountId: tx.transferAccountId, name: tx.payeeName ?? "" }
    : tx.payeeId
      ? { kind: "id", id: tx.payeeId, name: tx.payeeName ?? "" }
      : { kind: "none" }

export const payeeInputOf = (value: PayeeValue) =>
  value.kind === "none"
    ? ({ kind: "none" } as const)
    : value.kind === "id"
      ? ({ kind: "id", id: value.id } as const)
      : value.kind === "transfer"
        ? ({ kind: "transfer", accountId: value.accountId } as const)
        : ({ kind: "name", name: value.name } as const)

/**
 * Deletes transactions and offers to undo it from the toast. The toast is raised from the
 * mutation options, not from `mutate` callbacks: the row that started the deletion unmounts as
 * soon as the list refreshes.
 */
export function useDeleteTransactions(onSuccess?: () => void) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (ids: ReadonlyArray<string>) => deleteTransactions({ data: { ids: [...ids] } }),
    onSuccess: async ({ undoId }, ids) => {
      const undo = () =>
        restoreTransactions({ data: { undoId } })
          .then(() => refreshAfter(client, ["transactions"]))
          .then(() => toast("Suppression annulée"), toastError)
      toast(`${count(ids.length, "opération")} ${plural(ids.length, "supprimée")}`, {
        action: { label: "Annuler", run: () => void undo() },
        duration: 8000,
      })
      await refreshAfter(client, ["transactions"])
      onSuccess?.()
    },
    onError: (error) => toastError(error),
  })
}

type SplitLine = { key: string; amount: string; categoryId: string | null; notes: string }

const splitLine = (line: Omit<SplitLine, "key">): SplitLine => ({ key: crypto.randomUUID(), ...line })

/** Full editor for one transaction, including its split lines. */
export function TransactionEditor({
  tx,
  splits,
  onClose,
}: {
  tx: TxRow
  splits: ReadonlyArray<TxRow> | undefined
  onClose: () => void
}) {
  const [date, setDate] = React.useState(tx.date)
  const [amount, setAmount] = React.useState(amountInput(tx.amount))
  const [payee, setPayee] = React.useState<PayeeValue>(payeeValueOf(tx))
  const [categoryId, setCategoryId] = React.useState<string | null>(tx.categoryId)
  const [accountId, setAccountId] = React.useState(tx.accountId)
  const [notes, setNotes] = React.useState(tx.notes ?? "")
  const [cleared, setCleared] = React.useState(tx.cleared)
  const [lines, setLines] = React.useState<SplitLine[]>(
    tx.isParent && splits ? splits.map((s) => splitLine({ amount: amountInput(s.amount), categoryId: s.categoryId, notes: s.notes ?? "" })) : [],
  )
  const update = useAction(updateTransaction, { success: "Opération modifiée", onSuccess: onClose, writes: ["transactions"] })
  const remove = useDeleteTransactions(onClose)

  const total = parseAmount(amount)
  const splitting = lines.length > 0
  const parsedLines = lines.map((l) => parseAmount(l.amount))
  const splitSum = parsedLines.reduce<number>((a, b) => a + (b ?? 0), 0)
  const remaining = (total ?? 0) - splitSum
  const splitsValid = !splitting || (lines.length >= 2 && parsedLines.every((p) => p !== null) && remaining === 0)

  const startSplit = () =>
    setLines([
      splitLine({ amount: amount, categoryId, notes: "" }),
      splitLine({ amount: "0", categoryId: null, notes: "" }),
    ])

  const save = () => {
    if (total === null || !splitsValid) return
    const payeeChanged = JSON.stringify(payeeInputOf(payee)) !== JSON.stringify(payeeInputOf(payeeValueOf(tx)))
    // A split parent opened without its lines must keep them: only send splits the editor knows.
    const splitsKnown = !tx.isParent || splits !== undefined
    const splitsChanged = splitsKnown && (tx.isParent || splitting)
    update.mutate({
      data: {
        id: tx.id,
        date,
        amount: total,
        ...(payeeChanged ? { payee: payeeInputOf(payee) } : {}),
        ...(accountId !== tx.accountId ? { accountId } : {}),
        ...(splitting || !splitsKnown ? {} : { categoryId }),
        notes: notes.trim() || null,
        cleared,
        ...(splitsChanged
          ? {
              splits: splitting
                ? lines.map((l, i) => ({ amount: parsedLines[i] ?? 0, categoryId: l.categoryId, notes: l.notes.trim() || null }))
                : null,
            }
          : {}),
      },
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Modifier l'opération"
      width={560}
      footer={
        <>
          <Button variant="danger" icon={<Trash2 size={13} />} onClick={() => remove.mutate([tx.id])} loading={remove.isPending}>
            Supprimer
          </Button>
          <div className="flex gap-2">
            <Button onClick={onClose}>Annuler</Button>
            <Button variant="primary" onClick={save} disabled={total === null || !splitsValid} loading={update.isPending}>
              Enregistrer
            </Button>
          </div>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 px-5 py-4 max-md:grid-cols-1">
        <Field label="Montant">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="num" inputMode="decimal" aria-label="Montant" />
        </Field>
        <Field label="Date">
          <DateInput value={date} onChange={setDate} />
        </Field>
        <Field label="Bénéficiaire">
          <PayeePicker value={payee} onChange={setPayee} currentAccountId={accountId} />
        </Field>
        <Field label="Compte">
          <AccountSelect value={accountId} onChange={setAccountId} />
        </Field>
        {!splitting ? (
          <Field label="Catégorie" group>
            <div className="flex gap-2">
              <CategoryPicker value={categoryId} onChange={setCategoryId} className="flex-1" />
              {payee.kind !== "transfer" ? (
                <Button onClick={startSplit} title="Répartir sur plusieurs catégories">
                  Ventiler
                </Button>
              ) : null}
            </div>
          </Field>
        ) : null}
        <Field label="Note" className={splitting ? "col-span-2 max-md:col-span-1" : ""}>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optionnel" />
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-fg-2 max-md:col-span-1">
          <Switch checked={cleared} onCheckedChange={setCleared} label="Pointée" />
          Pointée (vue sur le relevé)
        </label>
      </div>
      {splitting ? (
        <div className="border-t border-line px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium">Ventilation</span>
            <span className={cx("num text-[12px]", remaining === 0 ? "text-muted" : "text-warning")}>
              {remaining === 0 ? "Équilibrée" : `Reste ${formatMoney(remaining)} à répartir`}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {lines.map((line, i) => (
              <div key={line.key} className="grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_32px] items-center gap-2 max-md:grid-cols-[90px_minmax(0,1fr)_32px]">
                <Input
                  value={line.amount}
                  aria-label={`Montant ligne ${i + 1}`}
                  onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, amount: e.target.value } : l)))}
                  className="num text-right"
                />
                <CategoryPicker
                  value={line.categoryId}
                  onChange={(c) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, categoryId: c } : l)))}
                />
                <Input
                  value={line.notes}
                  placeholder="Note"
                  className="max-md:hidden"
                  onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, notes: e.target.value } : l)))}
                />
                <IconButton label="Retirer la ligne" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={13} />}
              onClick={() => setLines((ls) => [...ls, splitLine({ amount: amountInput(remaining), categoryId: null, notes: "" })])}
            >
              Ajouter une ligne
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setLines([])}>
              Annuler la ventilation
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}

/** "Toujours catégoriser X en Y": creates a payee rule from an example transaction. */
export function RuleFromTransactionDialog({
  tx,
  onClose,
}: {
  tx: Pick<TxRow, "payeeName" | "importedPayee" | "categoryId">
  onClose: () => void
}) {
  const categories = useQuery(q.categories())
  const [field, setField] = React.useState<"payee" | "imported_payee">(tx.importedPayee ? "imported_payee" : "payee")
  const [op, setOp] = React.useState<"is" | "contains">(tx.importedPayee ? "contains" : "is")
  const [value, setValue] = React.useState((field === "imported_payee" ? tx.importedPayee : tx.payeeName) ?? "")
  const [categoryId, setCategoryId] = React.useState<string | null>(tx.categoryId)
  const [applyNow, setApplyNow] = React.useState(true)
  const create = useAction(createRule, {
    writes: ["rules", "transactions"],
    success: (r) => (r.applied ? `Règle créée · ${count(r.applied, "opération")} ${plural(r.applied, "catégorisée")}` : "Règle créée"),
    onSuccess: onClose,
  })
  const categoryName = categories.data?.flatMap((g) => g.categories).find((c) => c.id === categoryId)?.name
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Créer une règle"
      description="Les prochaines opérations qui correspondent seront catégorisées automatiquement."
      width={460}
      footer={
        <>
          <label className="flex items-center gap-2 text-muted">
            <Checkbox checked={applyNow} onCheckedChange={setApplyNow} label="Appliquer maintenant" />
            Appliquer aux opérations non catégorisées
          </label>
          <Button
            variant="primary"
            disabled={!categoryId || value.trim() === ""}
            loading={create.isPending}
            onClick={() =>
              categoryId &&
              create.mutate({
                data: {
                  rule: {
                    conditionsOp: "and",
                    conditions: [{ field, op, value: value.trim() }],
                    actions: [{ type: "set_category", categoryId }],
                  },
                  applyNow,
                },
              })
            }
          >
            Créer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Si">
            <Select
              value={field}
              onChange={setField}
              options={[
                { value: "payee", label: "le bénéficiaire" },
                { value: "imported_payee", label: "le libellé bancaire" },
              ]}
            />
          </Field>
          <Field label="Opérateur">
            <Select
              value={op}
              onChange={setOp}
              options={[
                { value: "is", label: "est" },
                { value: "contains", label: "contient" },
              ]}
            />
          </Field>
        </div>
        <Field label="Texte">
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Alors catégoriser en">
          <CategoryPicker value={categoryId} onChange={setCategoryId} allowNone={false} />
        </Field>
        {categoryName && value ? (
          <p className="text-[12px] text-muted">
            Si {field === "payee" ? "le bénéficiaire" : "le libellé bancaire"} {op === "is" ? "est" : "contient"} « {value} »,
            catégoriser en {categoryName}.
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

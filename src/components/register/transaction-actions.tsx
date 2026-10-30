import { CalendarClock, CheckCheck, Copy, Pencil, Split, Trash2, Wand2 } from "lucide-react"
import * as React from "react"
import { ScheduleDialog } from "~/components/schedule-dialog"
import { RuleFromTransactionDialog, TransactionEditor, payeeInputOf, payeeValueOf, useDeleteTransactions } from "~/components/transaction-editor"
import type { MenuItem } from "~/components/ui"
import { patchTransactionRows, useAction } from "~/lib/queries"
import { createTransaction, setTransactionsCleared } from "~/server/fns/core"
import type { TxRow } from "~/server/services/transactions"

type TransactionDialog = "edit" | "rule" | "schedule"

/**
 * The actions on an operation, shared by the desktop register (one per row) and the mobile list
 * (one for the whole list). `dialogs` must be rendered by the caller.
 */
export function useTransactionActions({
  accountId,
  today,
  splitsOf,
}: {
  accountId?: string
  /** A duplicate is dated today. */
  today: string
  splitsOf: (tx: TxRow) => TxRow[] | undefined
}) {
  const [opened, setOpened] = React.useState<{ kind: TransactionDialog; tx: TxRow } | null>(null)
  const cleared = useAction(setTransactionsCleared, {
    writes: ["cleared"],
    optimistic: ({ data }, client) => patchTransactionRows(client, data.ids, { cleared: data.cleared }),
  })
  const remove = useDeleteTransactions()
  const duplicate = useAction(createTransaction, { success: "Opération dupliquée", writes: ["transactions"] })
  const open = (kind: TransactionDialog, tx: TxRow) => setOpened({ kind, tx })
  const toggleCleared = (tx: TxRow) => cleared.mutate({ data: { ids: [tx.id], cleared: !tx.cleared } })

  const actionsFor = (tx: TxRow): MenuItem[] => [
    { label: "Modifier…", icon: <Pencil size={13} />, onSelect: () => open("edit", tx) },
    { label: "Ventiler…", icon: <Split size={13} />, onSelect: () => open("edit", tx), disabled: !!tx.transferAccountId },
    {
      label: "Dupliquer",
      icon: <Copy size={13} />,
      onSelect: () =>
        duplicate.mutate({
          data: {
            accountId: tx.accountId,
            date: today,
            amount: tx.amount,
            payee: payeeInputOf(payeeValueOf(tx)),
            categoryId: tx.categoryId,
            notes: tx.notes,
          },
        }),
    },
    { label: "Toujours catégoriser ainsi…", icon: <Wand2 size={13} />, onSelect: () => open("rule", tx), disabled: !tx.payeeName },
    { label: "Rendre récurrente…", icon: <CalendarClock size={13} />, onSelect: () => open("schedule", tx) },
    { label: tx.cleared ? "Dépointer" : "Pointer", icon: <CheckCheck size={13} />, onSelect: () => toggleCleared(tx), disabled: tx.reconciled },
    { separator: true },
    { label: "Supprimer", icon: <Trash2 size={13} />, danger: true, onSelect: () => remove.mutate([tx.id]), disabled: !!tx.parentId },
  ]

  const close = () => setOpened(null)
  const dialogs = !opened ? null : opened.kind === "edit" ? (
    <TransactionEditor tx={opened.tx} splits={splitsOf(opened.tx)} onClose={close} />
  ) : opened.kind === "rule" ? (
    <RuleFromTransactionDialog tx={opened.tx} onClose={close} />
  ) : (
    <ScheduleDialog
      initial={{
        name: opened.tx.payeeName ?? "",
        payee: payeeValueOf(opened.tx),
        accountId: accountId ?? opened.tx.accountId,
        categoryId: opened.tx.categoryId,
        amount: opened.tx.amount,
        startDate: opened.tx.date,
      }}
      onClose={close}
    />
  )

  return { actionsFor, open, toggleCleared, remove, dialogs }
}

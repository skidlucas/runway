import { useQuery } from "@tanstack/react-query"
import { useConfirm } from "~/components/ui"
import { formatDayShort } from "~/domain/dates"
import { q, useAction, useCategoryName } from "~/lib/queries"
import { postSchedule, skipSchedule } from "~/server/fns/planning"
import type { ScheduledRow } from "~/server/services/schedules"
import type { TxRow } from "~/server/services/transactions"

/** Each schedule line goes above the operations of its day; both lists are newest first. */
export function interleave<T>(rows: TxRow[], scheduled: ScheduledRow[], ofTx: (tx: TxRow) => T[], ofScheduled: (row: ScheduledRow) => T): T[] {
  const out: T[] = []
  let i = 0
  for (const tx of rows) {
    while (i < scheduled.length && scheduled[i]!.date >= tx.date) out.push(ofScheduled(scheduled[i++]!))
    out.push(...ofTx(tx))
  }
  while (i < scheduled.length) out.push(ofScheduled(scheduled[i++]!))
  return out
}

export const scheduledKey = (row: ScheduledRow) => `schedule:${row.scheduleId}:${row.dueDate}`

export function useScheduledRow(row: ScheduledRow) {
  const post = useAction(postSchedule, { success: "Opération enregistrée", writes: ["transactions", "schedules"] })
  const skip = useAction(skipSchedule, { success: "Échéance passée", writes: ["schedules"] })
  const accounts = useQuery(q.accounts())
  const category = useCategoryName(row.categoryId)
  const { confirm, dialog } = useConfirm()
  return {
    busy: post.isPending || skip.isPending,
    // A future occurrence is booked on its own day, an overdue one on its due day.
    post: () => post.mutate({ data: { id: row.scheduleId, ...(row.overdue ? {} : { date: row.date }) } }),
    skip: async () => {
      if (await confirm({ title: `Passer l'échéance « ${row.name} » ?`, confirmLabel: "Passer", tone: "primary" }))
        skip.mutate({ data: { id: row.scheduleId } })
    },
    confirmDialog: dialog,
    category: category ?? (row.transferAccountId ? "Virement" : "Hors budget"),
    account: accounts.data?.find((a) => a.id === row.accountId)?.name ?? "",
    date: row.overdue ? "en retard" : formatDayShort(row.date),
  }
}

import { useQuery } from "@tanstack/react-query"
import * as React from "react"
import { describeRecurrence, type Recurrence } from "~/domain/recurrence"
import { amountInput, parseAmount } from "~/domain/money"
import { localToday } from "~/lib/hooks"
import { q, useAction } from "~/lib/queries"
import { createSchedule, deleteSchedule, updateSchedule } from "~/server/fns/planning"
import type { ScheduleDto } from "~/server/services/schedules"
import { AccountSelect, CategoryPicker, PayeePicker, type PayeeValue } from "./pickers"
import { payeeInputOf } from "./transaction-editor"
import { Button, DateInput, Dialog, Field, Input, Segmented, Select, Switch, useConfirm } from "./ui"
import { capitalize } from "~/domain/text"

export type ScheduleInitial = {
  name?: string
  payee?: PayeeValue
  accountId?: string
  categoryId?: string | null
  amount?: number
  startDate?: string
  recurrence?: Recurrence
}

const FREQUENCIES: ReadonlyArray<{ value: string; label: string; recurrence: Recurrence }> = [
  { value: "once-1", label: "Une seule fois", recurrence: { unit: "once", interval: 1 } },
  { value: "week-1", label: "Toutes les semaines", recurrence: { unit: "week", interval: 1 } },
  { value: "week-2", label: "Toutes les 2 semaines", recurrence: { unit: "week", interval: 2 } },
  { value: "month-1", label: "Tous les mois", recurrence: { unit: "month", interval: 1 } },
  { value: "month-2", label: "Tous les 2 mois", recurrence: { unit: "month", interval: 2 } },
  { value: "month-3", label: "Tous les trimestres", recurrence: { unit: "month", interval: 3 } },
  { value: "month-6", label: "Tous les 6 mois", recurrence: { unit: "month", interval: 6 } },
  { value: "year-1", label: "Tous les ans", recurrence: { unit: "year", interval: 1 } },
]

const keyOf = (r: Recurrence) => `${r.unit}-${r.interval}`

/** Create or edit a recurring transaction ("échéance"). */
export function ScheduleDialog({
  schedule,
  initial,
  onClose,
}: {
  schedule?: ScheduleDto
  initial?: ScheduleInitial
  onClose: () => void
}) {
  const base: ScheduleInitial = schedule
    ? {
        name: schedule.name ?? "",
        payee: schedule.payeeId ? { kind: "id", id: schedule.payeeId, name: schedule.payeeName ?? "" } : { kind: "none" },
        accountId: schedule.accountId,
        categoryId: schedule.categoryId,
        amount: schedule.amount,
        startDate: schedule.nextDate,
        recurrence: schedule.recurrence,
      }
    : (initial ?? {})
  const [name, setName] = React.useState(base.name ?? "")
  const [payee, setPayee] = React.useState<PayeeValue>(base.payee ?? { kind: "none" })
  const [accountId, setAccountId] = React.useState(base.accountId ?? "")
  const [categoryId, setCategoryId] = React.useState<string | null>(base.categoryId ?? null)
  const [kind, setKind] = React.useState<"expense" | "income">((base.amount ?? -1) > 0 ? "income" : "expense")
  const [amount, setAmount] = React.useState(base.amount ? amountInput(Math.abs(base.amount)) : "")
  const [startDate, setStartDate] = React.useState(base.startDate ?? localToday())
  const [frequency, setFrequency] = React.useState(keyOf(base.recurrence ?? { unit: "month", interval: 1 }))
  // A rhythm imported from Actual ("every 5 weeks") stays selectable instead of falling back to monthly.
  const frequencies = React.useMemo(() => {
    const own = base.recurrence
    if (!own || FREQUENCIES.some((f) => f.value === keyOf(own))) return FREQUENCIES
    return [...FREQUENCIES, { value: keyOf(own), label: capitalize(describeRecurrence(own)), recurrence: own }]
  }, [base.recurrence])
  const [endDate, setEndDate] = React.useState(schedule?.endDate ?? "")
  const [autoPost, setAutoPost] = React.useState(schedule?.autoPost ?? false)

  const accounts = useQuery(q.accounts())
  React.useEffect(() => {
    if (accountId) return
    const first = accounts.data?.find((a) => !a.closed && !a.offBudget) ?? accounts.data?.[0]
    if (first) setAccountId(first.id)
  }, [accountId, accounts.data])

  const create = useAction(createSchedule, { success: "Échéance créée", onSuccess: onClose })
  const update = useAction(updateSchedule, { success: "Échéance modifiée", onSuccess: onClose })
  const remove = useAction(deleteSchedule, { success: "Échéance supprimée", onSuccess: onClose })
  const { confirm, dialog: confirmDialog } = useConfirm()

  const cents = parseAmount(amount)
  const recurrence = frequencies.find((f) => f.value === frequency)?.recurrence ?? { unit: "month", interval: 1 }
  const valid = cents !== null && cents !== 0 && accountId !== "" && startDate !== ""
  const once = recurrence.unit === "once"

  const submit = () => {
    if (!valid || cents === null) return
    const input = {
      name: name.trim() || null,
      payee: payeeInputOf(payee),
      accountId,
      categoryId,
      amount: kind === "expense" ? -Math.abs(cents) : Math.abs(cents),
      recurrence,
      // The form shows the next date; the rhythm keeps its original anchor unless that date is moved
      // (a schedule on the 31st that went through February must stay on the 31st).
      startDate: schedule && startDate === schedule.nextDate ? schedule.startDate : startDate,
      endDate: once ? null : endDate || null,
      autoPost,
    }
    if (schedule) update.mutate({ data: { id: schedule.id, input } })
    else create.mutate({ data: input })
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={schedule ? "Modifier l'échéance" : "Nouvelle échéance"}
      width={500}
      footer={
        <>
          {schedule ? (
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: `Supprimer l'échéance « ${schedule.name ?? schedule.payeeName ?? ""} » ?`,
                  description: "Les opérations déjà passées restent.",
                })
                if (ok) remove.mutate({ data: { id: schedule.id } })
              }}
            >
              Supprimer
            </Button>
          ) : (
            <span className="text-[12px] text-faint">{describeRecurrence(recurrence)}</span>
          )}
          <div className="flex gap-2">
            <Button onClick={onClose}>Annuler</Button>
            <Button variant="primary" onClick={submit} disabled={!valid} loading={create.isPending || update.isPending}>
              Enregistrer
            </Button>
          </div>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 px-5 py-4 max-md:grid-cols-1">
        <Field label="Nom" className="col-span-2 max-md:col-span-1">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Assurance habitation" autoFocus />
        </Field>
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "expense", label: "Dépense" },
            { value: "income", label: "Revenu" },
          ]}
          className="col-span-2 max-md:col-span-1"
        />
        <Field label="Montant">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="num" inputMode="decimal" aria-label="Montant" />
        </Field>
        <Field label="Fréquence">
          <Select value={frequency} onChange={setFrequency} options={frequencies} aria-label="Fréquence" />
        </Field>
        <Field label="Bénéficiaire">
          <PayeePicker value={payee} onChange={setPayee} currentAccountId={accountId} />
        </Field>
        <Field label="Compte">
          <AccountSelect value={accountId} onChange={setAccountId} />
        </Field>
        <Field label="Catégorie" hint="Sans catégorie budgétée, l'échéance est comptée « hors budget » dans la prévision">
          <CategoryPicker value={categoryId} onChange={setCategoryId} />
        </Field>
        <Field label={once ? "Date" : schedule ? "Prochaine date" : "Première date"}>
          <DateInput value={startDate} onChange={setStartDate} />
        </Field>
        {once ? null : (
          <Field label="Fin (optionnel)">
            <DateInput value={endDate} onChange={setEndDate} optional />
          </Field>
        )}
        <label className="flex items-center justify-between gap-3 self-end pb-1.5">
          <span>
            Saisie automatique
            <span className="block text-[12px] text-faint">Crée l'opération le jour J</span>
          </span>
          <Switch checked={autoPost} onCheckedChange={setAutoPost} label="Saisie automatique" />
        </label>
      </div>
      {confirmDialog}
    </Dialog>
  )
}

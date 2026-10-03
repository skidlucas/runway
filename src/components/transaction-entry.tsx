import { useQuery } from "@tanstack/react-query"
import { Delete } from "lucide-react"
import * as React from "react"
import { formatDayRelative, monthOf } from "~/domain/dates"
import { formatMoney, parseAmount } from "~/domain/money"
import { useIsMobile, useToday } from "~/lib/hooks"
import { q, useAction } from "~/lib/queries"
import { createTransaction } from "~/server/fns/core"
import { AccountSelect, CategoryPicker, PayeePicker, type PayeeValue } from "./pickers"
import { Button, cx, DateInput, Dialog, Field, Input, Segmented, Sheet } from "./ui"

type Kind = "expense" | "income"

export type EntryDefaults = { accountId?: string | undefined; categoryId?: string | undefined }

type Draft = {
  kind: Kind
  /** Raw text typed by the user, e.g. "42,18" or "=12+8". */
  amount: string
  payee: PayeeValue
  categoryId: string | null
  categoryTouched: boolean
  accountId: string
  date: string
  notes: string
}

function useEntryState(open: boolean, defaults: EntryDefaults) {
  const today = useToday()
  const accounts = useQuery(q.accounts())
  const payees = useQuery({ ...q.payees(), enabled: open })
  const firstAccount = (accounts.data ?? []).find((a) => !a.closed && !a.offBudget) ?? accounts.data?.[0]
  const blank = React.useCallback(
    (): Draft => ({
      kind: "expense",
      amount: "",
      payee: { kind: "none" },
      categoryId: defaults.categoryId ?? null,
      categoryTouched: defaults.categoryId !== undefined,
      accountId: defaults.accountId ?? firstAccount?.id ?? "",
      date: today,
      notes: "",
    }),
    [defaults.accountId, defaults.categoryId, firstAccount?.id, today],
  )
  const [draft, setDraft] = React.useState<Draft>(blank)

  React.useEffect(() => {
    if (open) setDraft(blank())
  }, [open, blank])

  const month = monthOf(draft.date || today)
  const budget = useQuery({ ...q.budget(month), enabled: open })
  const available = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const g of budget.data?.groups ?? []) for (const c of g.categories) map.set(c.id, c.available)
    return map
  }, [budget.data])

  const cents = parseAmount(draft.amount)
  const signed = cents === null ? null : draft.kind === "expense" ? -Math.abs(cents) : Math.abs(cents)

  const setPayee = (payee: PayeeValue) => {
    setDraft((d) => {
      const next = { ...d, payee }
      // Pre-fill the category with the one last used for this payee.
      if (!d.categoryTouched && payee.kind === "id") {
        const known = payees.data?.find((p) => p.id === payee.id)
        if (known?.lastCategoryId) next.categoryId = known.lastCategoryId
      }
      if (payee.kind === "transfer") next.categoryId = null
      return next
    })
  }

  const remaining =
    draft.categoryId && available.has(draft.categoryId)
      ? (available.get(draft.categoryId) ?? 0) + (signed ?? 0)
      : null

  return { draft, setDraft, setPayee, available, signed, remaining, accounts, today }
}

export function TransactionEntry({
  open,
  onOpenChange,
  defaults,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaults: EntryDefaults
}) {
  const mobile = useIsMobile()
  const state = useEntryState(open, defaults)
  const { draft, signed } = state
  const create = useAction(createTransaction, {
    success: "Opération ajoutée",
    onSuccess: () => onOpenChange(false),
  })

  const canSubmit = signed !== null && signed !== 0 && draft.accountId !== "" && draft.date !== ""
  const submit = () => {
    if (!canSubmit || signed === null || create.isPending) return
    create.mutate({
      data: {
        accountId: draft.accountId,
        date: draft.date,
        amount: signed,
        payee:
          draft.payee.kind === "none"
            ? { kind: "none" }
            : draft.payee.kind === "id"
              ? { kind: "id", id: draft.payee.id }
              : draft.payee.kind === "transfer"
                ? { kind: "transfer", accountId: draft.payee.accountId }
                : { kind: "name", name: draft.payee.name },
        categoryId: draft.categoryId,
        notes: draft.notes.trim() || null,
        cleared: false,
      },
    })
  }

  if (mobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} title="Nouvelle opération">
        <MobileEntry state={state} onCancel={() => onOpenChange(false)} onSubmit={submit} pending={create.isPending} canSubmit={canSubmit} />
      </Sheet>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Nouvelle opération"
      width={480}
      footer={
        <>
          <span className="text-[12px] text-faint">Entrée pour valider</span>
          <div className="flex gap-2">
            <Button onClick={() => onOpenChange(false)}>Annuler</Button>
            <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={create.isPending}>
              Ajouter
            </Button>
          </div>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          const target = e.target as HTMLElement
          // Pickers render in a portal but their key events still bubble here through React:
          // Enter there picks an option, it must not submit the form.
          if (e.key === "Enter" && target.tagName === "INPUT" && !e.nativeEvent.defaultPrevented && !target.closest("[cmdk-root]")) {
            e.preventDefault()
            submit()
          }
        }}
      >
        <Segmented
          value={draft.kind}
          onChange={(kind) => state.setDraft((d) => ({ ...d, kind }))}
          options={[
            { value: "expense", label: "Dépense" },
            { value: "income", label: "Revenu" },
          ]}
          className="w-full"
        />
        <div className="flex items-baseline justify-center gap-1 py-2">
          <input
            aria-label="Montant"
            autoFocus
            inputMode="decimal"
            placeholder="0,00"
            value={draft.amount}
            onChange={(e) => state.setDraft((d) => ({ ...d, amount: e.target.value }))}
            className="num w-[260px] bg-transparent text-center text-[40px] font-medium tracking-[-0.03em] outline-none placeholder:text-ghost"
          />
          <span className="num text-[28px] text-faint">€</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bénéficiaire">
            <PayeePicker value={draft.payee} onChange={state.setPayee} currentAccountId={draft.accountId} />
          </Field>
          <Field
            label="Catégorie"
            hint={
              state.remaining !== null ? (
                <span className={cx("num", state.remaining < 0 ? "text-negative" : "text-positive")}>
                  {formatMoney(state.remaining)} dispo après cette opération
                </span>
              ) : undefined
            }
          >
            <CategoryPicker
              value={draft.categoryId}
              available={state.available}
              onChange={(categoryId) => state.setDraft((d) => ({ ...d, categoryId, categoryTouched: true }))}
            />
          </Field>
          <Field label="Compte">
            <AccountSelect value={draft.accountId} onChange={(accountId) => state.setDraft((d) => ({ ...d, accountId }))} />
          </Field>
          <Field label="Date">
            <DateInput value={draft.date} onChange={(date) => state.setDraft((d) => ({ ...d, date }))} />
          </Field>
        </div>
        <Field label="Note">
          <Input value={draft.notes} onChange={(e) => state.setDraft((d) => ({ ...d, notes: e.target.value }))} placeholder="Optionnel" />
        </Field>
      </form>
    </Dialog>
  )
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ",", "0", "⌫"] as const

function MobileEntry({
  state,
  onCancel,
  onSubmit,
  pending,
  canSubmit,
}: {
  state: ReturnType<typeof useEntryState>
  onCancel: () => void
  onSubmit: () => void
  pending: boolean
  canSubmit: boolean
}) {
  const { draft, setDraft } = state
  const press = (key: (typeof KEYS)[number]) =>
    setDraft((d) => {
      if (key === "⌫") return { ...d, amount: d.amount.slice(0, -1) }
      if (key === ",") return d.amount.includes(",") ? d : { ...d, amount: (d.amount || "0") + "," }
      const [, decimals] = d.amount.split(",")
      if (decimals !== undefined && decimals.length >= 2) return d
      if (d.amount === "0") return { ...d, amount: key }
      return { ...d, amount: d.amount + key }
    })

  const accountName = state.accounts.data?.find((a) => a.id === draft.accountId)?.name ?? "—"

  return (
    <div className="flex h-full flex-col pt-[env(safe-area-inset-top)]">
      <div className="flex items-center justify-between px-5 pb-3 pt-4">
        <button type="button" className="text-muted" onClick={onCancel}>
          Annuler
        </button>
        <span className="font-semibold">Nouvelle opération</span>
        <button
          type="button"
          className={cx("font-semibold", canSubmit ? "text-accent" : "text-ghost")}
          onClick={onSubmit}
          disabled={!canSubmit || pending}
        >
          OK
        </button>
      </div>
      <Segmented
        value={draft.kind}
        onChange={(kind) => setDraft((d) => ({ ...d, kind }))}
        options={[
          { value: "expense", label: "Dépense" },
          { value: "income", label: "Revenu" },
        ]}
        className="mx-5"
      />
      <div className="num px-5 pb-6 pt-8 text-center text-[52px] font-medium tracking-[-0.03em]" aria-live="polite">
        {draft.amount || "0"}
        <span className="text-[#a3a7ae]"> €</span>
      </div>
      <div className="mx-5 flex flex-col rounded-[10px] border border-line">
        <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-[13px]">
          <span className="text-muted">Bénéficiaire</span>
          <PayeePicker
            value={draft.payee}
            onChange={state.setPayee}
            currentAccountId={draft.accountId}
            variant="inline"
            className="min-w-0 flex-1"
            triggerClassName="justify-end text-right font-medium"
            placeholder="Choisir"
          />
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-[13px]">
          <span className="text-muted">Catégorie</span>
          <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <CategoryPicker
              value={draft.categoryId}
              available={state.available}
              onChange={(categoryId) => setDraft((d) => ({ ...d, categoryId, categoryTouched: true }))}
              variant="inline"
              className="min-w-0"
              triggerClassName="justify-end text-right font-medium"
              placeholder="Choisir"
            />
            {state.remaining !== null ? (
              <span className={cx("num shrink-0 text-[12px]", state.remaining < 0 ? "text-negative" : "text-positive")}>
                {formatMoney(state.remaining)} dispo
              </span>
            ) : null}
          </span>
        </div>
        <label className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-[13px]">
          <span className="text-muted">Compte</span>
          <span className="relative font-medium">
            {accountName}
            <select
              aria-label="Compte"
              value={draft.accountId}
              onChange={(e) => setDraft((d) => ({ ...d, accountId: e.target.value }))}
              className="absolute inset-0 opacity-0"
            >
              {(state.accounts.data ?? [])
                .filter((a) => !a.closed)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </span>
        </label>
        <label className="flex items-center justify-between gap-3 px-3.5 py-[13px]">
          <span className="text-muted">Date</span>
          <span className="relative font-medium">
            {draft.date ? formatDayRelative(draft.date, state.today) : "—"}
            <input
              type="date"
              aria-label="Date"
              value={draft.date}
              onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
              className="absolute inset-0 opacity-0"
            />
          </span>
        </label>
      </div>
      <div className="mt-auto grid grid-cols-3 gap-1.5 bg-subtle px-3 pb-[calc(34px+env(safe-area-inset-bottom))] pt-3">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            aria-label={k === "⌫" ? "Effacer" : k}
            className="num flex h-[50px] items-center justify-center rounded-[8px] bg-[var(--key-bg)] text-[22px] shadow-[0_1px_0_rgba(0,0,0,0.06)] active:opacity-70"
          >
            {k === "⌫" ? <Delete size={20} strokeWidth={1.5} /> : k}
          </button>
        ))}
      </div>
    </div>
  )
}

import { useQuery } from "@tanstack/react-query"
import { Lock, Pencil, Trash2 } from "lucide-react"
import * as React from "react"
import { amountInput, formatMoney, parseAmount } from "~/domain/money"
import { count } from "~/domain/text"
import { localToday } from "~/lib/hooks"
import { q, useAction } from "~/lib/queries"
import { createAccount, deleteAccount, reconcileAccount, setAccountClosed, updateAccount } from "~/server/fns/core"
import { ACCOUNT_KINDS, type AccountKind } from "~/domain/accounts"
import type { AccountDto } from "~/server/services/accounts"
import { Button, DateInput, Dialog, Field, Input, type MenuItem, Select, Switch, useConfirm } from "./ui"

const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  checking: "Compte courant",
  savings: "Épargne",
  credit: "Carte de crédit",
  investment: "Placement",
  other: "Autre",
}
const ACCOUNT_KIND_OPTIONS = ACCOUNT_KINDS.map((value) => ({ value, label: ACCOUNT_KIND_LABELS[value] }))

type AccountDialog = "edit" | "reconcile"

/** The actions on an account, shared by its page and the sidebar. `dialogs` must be rendered by the caller. */
export function useAccountActions({ onRemoved }: { onRemoved?: (id: string) => void } = {}) {
  const accounts = useQuery(q.accounts())
  const [opened, setOpened] = React.useState<{ kind: AccountDialog; id: string } | null>(null)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const close = useAction(setAccountClosed, { success: "Compte mis à jour", writes: ["accounts"] })
  const remove = useAction(deleteAccount, { success: "Compte supprimé", writes: ["everything"] })
  const openDialog = (kind: AccountDialog, account: AccountDto) => setOpened({ kind, id: account.id })
  const account = opened && accounts.data?.find((a) => a.id === opened.id)

  const actionsFor = (account: AccountDto): MenuItem[] => [
    { label: "Modifier le compte", icon: <Pencil size={13} />, onSelect: () => openDialog("edit", account) },
    { label: "Rapprocher", icon: <Lock size={13} />, onSelect: () => openDialog("reconcile", account) },
    {
      label: account.closed ? "Rouvrir le compte" : "Clôturer le compte",
      onSelect: () => close.mutate({ data: { id: account.id, closed: !account.closed } }),
    },
    { separator: true },
    {
      label: "Supprimer le compte",
      danger: true,
      icon: <Trash2 size={13} />,
      onSelect: async () => {
        const ok = await confirm({
          title: `Supprimer « ${account.name} »${account.transactionCount === 1 ? " et son opération" : account.transactionCount > 1 ? ` et ses ${count(account.transactionCount, "opération")}` : ""} ?`,
        })
        if (ok) remove.mutate({ data: { id: account.id } }, { onSuccess: () => onRemoved?.(account.id) })
      },
    },
  ]

  const dialogs = (
    <>
      {opened?.kind === "edit" && account ? <EditAccountDialog account={account} onClose={() => setOpened(null)} /> : null}
      {opened?.kind === "reconcile" && account ? <ReconcileDialog account={account} onClose={() => setOpened(null)} /> : null}
      {confirmDialog}
    </>
  )
  return { actionsFor, openDialog, dialogs }
}

export function CreateAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const [name, setName] = React.useState("")
  const [kind, setKind] = React.useState<AccountKind>("checking")
  const [offBudget, setOffBudget] = React.useState(false)
  const [balance, setBalance] = React.useState("")
  const [date, setDate] = React.useState(localToday())
  const create = useAction(createAccount, {
    success: "Compte créé",
    writes: ["accounts", "transactions"],
    // onCreated usually navigates away; closing as well would navigate back over it.
    onSuccess: (id) => (onCreated ? onCreated(id) : onClose()),
  })
  const cents = balance.trim() === "" ? 0 : parseAmount(balance)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Nouveau compte"
      width={440}
      footer={
        <>
          <span />
          <div className="flex gap-2">
            <Button onClick={onClose}>Annuler</Button>
            <Button
              variant="primary"
              disabled={name.trim() === "" || cents === null}
              loading={create.isPending}
              onClick={() =>
                cents !== null &&
                create.mutate({ data: { name, kind, offBudget, startingBalance: cents, startingDate: date } })
              }
            >
              Créer
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <Field label="Nom">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Compte courant" />
        </Field>
        <Field label="Type">
          <Select value={kind} onChange={(k) => {
            setKind(k)
            if (k === "investment" || k === "savings") setOffBudget(true)
            else setOffBudget(false)
          }} options={ACCOUNT_KIND_OPTIONS} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Solde actuel">
            <Input value={balance} onChange={(e) => setBalance(e.target.value)} className="num" placeholder="0,00" inputMode="decimal" />
          </Field>
          <Field label="Au">
            <DateInput value={date} onChange={setDate} />
          </Field>
        </div>
        <label className="flex items-center justify-between gap-3">
          <span>
            Hors budget
            <span className="block text-[12px] text-faint">Suivi du solde seulement (épargne, placements, prêt)</span>
          </span>
          <Switch checked={offBudget} onCheckedChange={setOffBudget} label="Hors budget" />
        </label>
      </div>
    </Dialog>
  )
}

export function EditAccountDialog({ account, onClose }: { account: AccountDto; onClose: () => void }) {
  const [name, setName] = React.useState(account.name)
  const [kind, setKind] = React.useState<AccountKind>(account.kind)
  const [inForecast, setInForecast] = React.useState(account.inForecast)
  const [offBudget, setOffBudget] = React.useState(account.offBudget)
  const [inNetWorth, setInNetWorth] = React.useState(account.inNetWorth)
  const update = useAction(updateAccount, { success: "Compte modifié", onSuccess: onClose, writes: ["accounts", "transactionCategories"] })
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Modifier le compte"
      width={440}
      footer={
        <>
          <span />
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() => update.mutate({ data: { id: account.id, name, kind, inForecast, offBudget, inNetWorth } })}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <Field label="Nom">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={kind} onChange={setKind} options={ACCOUNT_KIND_OPTIONS} />
        </Field>
        <label className="flex items-center justify-between gap-3">
          <span>
            Hors budget
            <span className="block text-[12px] text-faint">Les opérations ne comptent plus dans le budget</span>
          </span>
          <Switch checked={offBudget} onCheckedChange={setOffBudget} label="Hors budget" />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>
            Inclus dans la prévision
            <span className="block text-[12px] text-faint">Son solde compte dans « Fin de mois »</span>
          </span>
          <Switch checked={inForecast} onCheckedChange={setInForecast} label="Inclus dans la prévision" />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>
            Compté dans le patrimoine
            <span className="block text-[12px] text-faint">Sinon, il reste suivi à part, sous « Hors patrimoine »</span>
          </span>
          <Switch checked={inNetWorth} onCheckedChange={setInNetWorth} label="Compté dans le patrimoine" />
        </label>
      </div>
    </Dialog>
  )
}

export function ReconcileDialog({ account, onClose }: { account: AccountDto; onClose: () => void }) {
  const [statement, setStatement] = React.useState(amountInput(account.clearedBalance))
  const reconcile = useAction(reconcileAccount, {
    writes: ["transactions", "accounts"],
    success: (r) => (r.adjustment === 0 ? "Compte rapproché" : `Compte rapproché · ajustement de ${formatMoney(r.adjustment)}`),
    onSuccess: onClose,
  })
  const cents = parseAmount(statement)
  const diff = cents === null ? null : cents - account.clearedBalance
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Rapprocher ${account.name}`}
      description="Saisis le solde de ton relevé bancaire. Les opérations pointées seront verrouillées."
      width={440}
      footer={
        <>
          <span className="text-[12px] text-muted">
            {diff === null ? "Montant invalide" : diff === 0 ? "Tout correspond" : `Écart de ${formatMoney(diff)} : un ajustement sera créé`}
          </span>
          <Button
            variant="primary"
            disabled={cents === null}
            loading={reconcile.isPending}
            onClick={() => cents !== null && reconcile.mutate({ data: { id: account.id, statementBalance: cents } })}
          >
            Rapprocher
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex justify-between text-muted">
          <span>Solde pointé</span>
          <span className="num text-fg">{formatMoney(account.clearedBalance)}</span>
        </div>
        <div className="flex justify-between text-muted">
          <span>Non pointé</span>
          <span className="num text-fg">{formatMoney(account.balance - account.clearedBalance)}</span>
        </div>
        <Field label="Solde du relevé">
          <Input value={statement} onChange={(e) => setStatement(e.target.value)} className="num" autoFocus />
        </Field>
      </div>
    </Dialog>
  )
}

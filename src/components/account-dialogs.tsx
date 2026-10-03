import * as React from "react"
import { amountInput, formatMoney, parseAmount } from "~/domain/money"
import { localToday } from "~/lib/hooks"
import { useAction } from "~/lib/queries"
import { createAccount, reconcileAccount, updateAccount } from "~/server/fns/core"
import type { AccountDto, AccountKind } from "~/server/services/accounts"
import { Button, Dialog, Field, Input, Select, Switch } from "./ui"

export const ACCOUNT_KINDS: ReadonlyArray<{ value: AccountKind; label: string }> = [
  { value: "checking", label: "Compte courant" },
  { value: "savings", label: "Épargne" },
  { value: "credit", label: "Carte de crédit" },
  { value: "investment", label: "Placement" },
  { value: "other", label: "Autre" },
]

export function CreateAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const [name, setName] = React.useState("")
  const [kind, setKind] = React.useState<AccountKind>("checking")
  const [offBudget, setOffBudget] = React.useState(false)
  const [balance, setBalance] = React.useState("")
  const [date, setDate] = React.useState(localToday())
  const create = useAction(createAccount, {
    success: "Compte créé",
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
          }} options={ACCOUNT_KINDS} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Solde actuel">
            <Input value={balance} onChange={(e) => setBalance(e.target.value)} className="num" placeholder="0,00" inputMode="decimal" />
          </Field>
          <Field label="Au">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
  const update = useAction(updateAccount, { success: "Compte modifié", onSuccess: onClose })
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
            onClick={() => update.mutate({ data: { id: account.id, name, kind, inForecast, offBudget } })}
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
          <Select value={kind} onChange={setKind} options={ACCOUNT_KINDS} />
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
      </div>
    </Dialog>
  )
}

export function ReconcileDialog({ account, onClose }: { account: AccountDto; onClose: () => void }) {
  const [statement, setStatement] = React.useState(amountInput(account.clearedBalance))
  const reconcile = useAction(reconcileAccount, {
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

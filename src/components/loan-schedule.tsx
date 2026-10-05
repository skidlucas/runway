import { MoreHorizontal, RotateCcw } from "lucide-react"
import * as React from "react"
import { type Day, formatMonthLong, monthOf } from "~/domain/dates"
import { amountInput, parseAmount } from "~/domain/money"
import { type LoanPayment, type LoanRow, type LoanTerms, loanSchedule, nextInstallment } from "~/domain/wealth"
import { useAction } from "~/lib/queries"
import { setLoanPayments } from "~/server/fns/wealth"
import { Button, Chip, cx, Dialog, Field, IconButton, InlineEdit, Input, Menu, Money } from "./ui"

/** The amortization schedule of a loan, for the whole contract, with every installment editable. */
export function LoanScheduleDialog({ assetId, terms, today, onClose }: { assetId: string; terms: LoanTerms; today: Day; onClose: () => void }) {
  const schedule = React.useMemo(() => loanSchedule(terms), [terms])
  const next = nextInstallment(terms, schedule, today)
  const insured = (terms.insurance ?? 0) > 0
  const columns = insured
    ? "grid-cols-[110px_minmax(0,1fr)_90px_90px_80px_90px_110px_28px] max-md:grid-cols-[90px_minmax(0,1fr)_100px_28px]"
    : "grid-cols-[110px_minmax(0,1fr)_100px_100px_120px_28px] max-md:grid-cols-[90px_minmax(0,1fr)_100px_28px]"
  const nextRow = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => nextRow.current?.scrollIntoView({ block: "center" }), [])
  const change = useAction(setLoanPayments, { writes: ["assets"] })
  const set = (installment: number, payment: LoanPayment | null) => change.mutate({ data: { id: assetId, changes: [{ installment, payment }] } })
  const [stepFrom, setStepFrom] = React.useState<LoanRow | null>(null)

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Tableau d'amortissement"
      description="Montants du contrat entier. Une mensualité modifiée ne vaut que pour son échéance, une nouvelle mensualité vaut aussi pour les suivantes. Un report repousse la fin du prêt, un remboursement anticipé la rapproche."
      width={820}
    >
      <div role="table" aria-label="Échéances du prêt" className="text-[12px]">
        <div role="row" className={cx("sticky top-0 z-10 grid items-center gap-3 border-b border-line bg-elevated px-5 py-2 text-faint", columns)}>
          <span role="columnheader">Échéance</span>
          <span role="columnheader" className="text-right">Mensualité</span>
          <span role="columnheader" className="text-right max-md:hidden">Intérêts</span>
          <span role="columnheader" className="text-right max-md:hidden">Capital</span>
          {insured ? <span role="columnheader" className="text-right max-md:hidden">Assurance</span> : null}
          {insured ? <span role="columnheader" className="text-right max-md:hidden">Total</span> : null}
          <span role="columnheader" className="text-right">Restant dû</span>
          <span />
        </div>
        {schedule.map((row) => (
          <ScheduleRow
            key={row.installment}
            ref={row.installment === next?.installment ? nextRow : undefined}
            row={row}
            columns={columns}
            insurance={insured ? (terms.insurance ?? 0) : null}
            paid={row.date <= today}
            current={row.installment === next?.installment}
            onChange={(payment) => set(row.installment, payment)}
            onNewPayment={() => setStepFrom(row)}
          />
        ))}
      </div>
      {stepFrom ? <NewPaymentDialog assetId={assetId} row={stepFrom} onClose={() => setStepFrom(null)} /> : null}
    </Dialog>
  )
}

/** A new constant payment from one installment onward, as the bank sets it after a deferral. */
function NewPaymentDialog({ assetId, row, onClose }: { assetId: string; row: LoanRow; onClose: () => void }) {
  const [text, setText] = React.useState(amountInput(row.payment))
  const payment = parseAmount(text)
  const valid = payment !== null && payment > 0
  const change = useAction(setLoanPayments, { writes: ["assets"], onSuccess: onClose })
  const submit = () => valid && change.mutate({ data: { id: assetId, changes: [{ installment: row.installment, payment, onward: true }] } })
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Nouvelle mensualité à partir de ${formatMonthLong(monthOf(row.date)).toLowerCase()}`}
      description="Capital et intérêts, hors assurance. Elle s'applique à cette échéance et aux suivantes, jusqu'à la prochaine nouvelle mensualité."
      width={420}
      footer={
        <>
          <span />
          <Button variant="primary" disabled={!valid} loading={change.isPending} onClick={submit}>
            Appliquer
          </Button>
        </>
      }
    >
      <form
        className="px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Mensualité">
          <Input value={text} onChange={(e) => setText(e.target.value)} className="num" inputMode="decimal" autoFocus />
        </Field>
      </form>
    </Dialog>
  )
}

function ScheduleRow({
  ref,
  row,
  columns,
  insurance,
  paid,
  current,
  onChange,
  onNewPayment,
}: {
  ref?: React.Ref<HTMLDivElement>
  row: LoanRow
  columns: string
  insurance: number | null
  paid: boolean
  current: boolean
  onChange: (payment: LoanPayment | null) => void
  onNewPayment: () => void
}) {
  const month = formatMonthLong(monthOf(row.date))
  return (
    <div
      ref={ref}
      role="row"
      data-testid="loan-row"
      className={cx("grid h-9 items-center gap-3 border-b border-line-subtle px-5", columns, paid && "text-muted", current && "bg-accent-soft")}
    >
      <span role="cell" className="truncate">{month}</span>
      <span role="cell" className="flex min-w-0 items-center justify-end gap-1.5">
        {row.override === "interest_only" ? <Chip>Intérêts seuls</Chip> : null}
        {row.override === "amount" ? <Chip>Modifiée</Chip> : null}
        {row.override === "step" ? <Chip>Nouvelle mensualité</Chip> : null}
        <InlineEdit
          value={amountInput(row.payment)}
          label={`Mensualité de ${month}`}
          inputMode="decimal"
          onCommit={(text) => {
            const payment = parseAmount(text)
            if (payment !== null && payment >= 0 && payment !== row.payment) onChange(payment)
          }}
          className="num text-right hover:text-fg"
          inputClassName="num w-24 text-right text-[12px]"
        >
          <Money value={row.payment} />
        </InlineEdit>
      </span>
      <Money value={row.interest} className="text-right max-md:hidden" />
      <Money value={row.capital} className="text-right max-md:hidden" />
      {insurance !== null ? <Money value={insurance} className="text-right max-md:hidden" /> : null}
      {insurance !== null ? <Money value={row.payment + insurance} className="text-right max-md:hidden" /> : null}
      <Money value={row.remaining} className="text-right" />
      <Menu
        trigger={
          <IconButton label={`Actions de l'échéance de ${month}`} size="sm">
            <MoreHorizontal size={14} />
          </IconButton>
        }
        items={[
          { label: "Intérêts seuls", disabled: row.override === "interest_only", onSelect: () => onChange("interest_only") },
          { label: "Nouvelle mensualité à partir d'ici…", onSelect: onNewPayment },
          { label: "Rétablir le calcul", icon: <RotateCcw size={13} />, disabled: row.override === null, onSelect: () => onChange(null) },
        ]}
      />
    </div>
  )
}

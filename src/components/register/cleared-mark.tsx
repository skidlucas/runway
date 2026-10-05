import { Lock } from "lucide-react"
import { cx } from "~/components/ui"
import type { TxRow } from "~/server/services/transactions"

/** A filled dot for a cleared operation, a hollow one otherwise, a lock once reconciled. */
export const ClearedMark = ({ tx }: { tx: Pick<TxRow, "cleared" | "reconciled"> }) =>
  tx.reconciled ? (
    <Lock size={11} className="text-faint" />
  ) : (
    <span className={cx("h-2 w-2 rounded-full border", tx.cleared ? "border-positive bg-positive" : "border-control-off")} />
  )

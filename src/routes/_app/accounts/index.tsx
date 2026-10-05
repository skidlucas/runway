import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ArrowDown, ArrowUp, ChevronRight, Plus } from "lucide-react"
import { CreateAccountDialog } from "~/components/account-dialogs"
import { PageHeader } from "~/components/shell"
import { Button, cx, EmptyState, IconButton, Money, revealOnHover, SkeletonRows } from "~/components/ui"
import { formatDayLong } from "~/domain/dates"
import { count } from "~/domain/text"
import { q, useAction } from "~/lib/queries"
import { reorderAccounts } from "~/server/fns/core"
import type { AccountDto } from "~/server/services/accounts"

export const Route = createFileRoute("/_app/accounts/")({
  validateSearch: (s: Record<string, unknown>): { new?: boolean } => (s.new ? { new: true } : {}),
  loader: ({ context }) => context.queryClient.ensureQueryData(q.accounts()),
  component: AccountsPage,
})

function AccountsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: "/accounts/" })
  const accounts = useQuery(q.accounts())
  const list = accounts.data ?? []
  const sections: Array<[string, AccountDto[]]> = [
    ["Budget", list.filter((a) => !a.offBudget && !a.closed)],
    ["Hors budget", list.filter((a) => a.offBudget && !a.closed)],
    ["Clôturés", list.filter((a) => a.closed)],
  ]
  const total = list.filter((a) => !a.closed).reduce((s, a) => s + a.balance, 0)
  const client = useQueryClient()
  const reorder = useAction(reorderAccounts, { scope: "reorder-accounts", writes: ["accounts"] })

  // Shown at once, so that a second click moves from the new position rather than the old one.
  const move = (section: number, index: number, delta: number) => {
    const next = sections.map(([, items]) => [...items])
    const items = next[section]
    const [account] = items?.splice(index, 1) ?? []
    if (!items || !account) return
    items.splice(index + delta, 0, account)
    const ordered = next.flat()
    client.setQueryData(q.accounts().queryKey, ordered)
    reorder.mutate({ data: { ids: ordered.map((a) => a.id) } })
  }

  return (
    <>
      <PageHeader
        title="Comptes"
        right={
          <Button icon={<Plus size={14} />} onClick={() => void navigate({ search: { new: true } })}>
            Ajouter un compte
          </Button>
        }
      />
      {!accounts.data ? (
        <SkeletonRows rows={5} height={46} />
      ) : list.length === 0 ? (
        <EmptyState
          title="Aucun compte pour l'instant."
          action={
            <Button variant="primary" onClick={() => void navigate({ search: { new: true } })}>
              Ajouter un compte
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col">
          <div className="flex items-baseline justify-between px-5 py-4">
            <span className="text-muted">Total des comptes ouverts</span>
            <Money value={total} className="text-[24px] max-md:text-[28px]" />
          </div>
          <Link
            to="/accounts/$accountId"
            params={{ accountId: "all" }}
            className="flex items-center justify-between border-y border-line px-5 py-3 hover:bg-hover"
          >
            <span>Toutes les opérations</span>
            <ChevronRight size={14} className="text-faint" />
          </Link>
          {sections.map(([title, items], si) =>
            items.length === 0 ? null : (
              <section key={title} aria-label={title} className="mt-4">
                <div className="px-5 pb-1.5 text-[12px] text-faint">{title}</div>
                {items.map((a, i) => (
                  <div key={a.id} data-testid="account-row" className="group flex items-center border-b border-line-subtle pr-3 hover:bg-hover">
                    <Link
                      to="/accounts/$accountId"
                      params={{ accountId: a.id }}
                      className="flex h-[46px] min-w-0 flex-1 items-center gap-3 pl-5 pr-2 max-md:h-[58px]"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cx("truncate font-medium", a.closed && "text-faint")}>{a.name}</span>
                        <span className="text-[12px] text-faint">
                          {count(a.transactionCount, "opération")}
                          {a.lastReconciledAt ? ` · rapproché le ${formatDayLong(a.lastReconciledAt)}` : ""}
                        </span>
                      </span>
                      <Money value={a.balance} className={cx("text-[13px]", a.balance < 0 && "text-negative")} />
                      <ChevronRight size={14} className="text-faint" />
                    </Link>
                    <span className={cx("flex items-center gap-1", revealOnHover)}>
                      <IconButton label="Monter" size="sm" disabled={i === 0} onClick={() => move(si, i, -1)}>
                        <ArrowUp size={13} />
                      </IconButton>
                      <IconButton label="Descendre" size="sm" disabled={i === items.length - 1} onClick={() => move(si, i, 1)}>
                        <ArrowDown size={13} />
                      </IconButton>
                    </span>
                  </div>
                ))}
              </section>
            ),
          )}
        </div>
      )}
      {search.new ? (
        <CreateAccountDialog
          onClose={() => void navigate({ search: {} })}
          onCreated={(id) => void navigate({ to: "/accounts/$accountId", params: { accountId: id } })}
        />
      ) : null}
    </>
  )
}

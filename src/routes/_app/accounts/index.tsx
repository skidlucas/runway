import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ChevronRight, Plus } from "lucide-react"
import { CreateAccountDialog } from "~/components/account-dialogs"
import { PageHeader } from "~/components/shell"
import { Button, cx, EmptyState, Money, SkeletonRows } from "~/components/ui"
import { q } from "~/lib/queries"
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
          {sections.map(([title, items]) =>
            items.length === 0 ? null : (
              <section key={title} className="mt-4">
                <div className="px-5 pb-1.5 text-[12px] text-faint">{title}</div>
                {items.map((a) => (
                  <Link
                    key={a.id}
                    to="/accounts/$accountId"
                    params={{ accountId: a.id }}
                    className="flex h-[46px] items-center gap-3 border-b border-line-subtle px-5 hover:bg-hover max-md:h-[58px]"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cx("truncate font-medium", a.closed && "text-faint")}>{a.name}</span>
                      <span className="text-[12px] text-faint">
                        {a.transactionCount} opération{a.transactionCount > 1 ? "s" : ""}
                        {a.lastReconciledAt ? ` · rapproché le ${a.lastReconciledAt.split("-").reverse().join("/")}` : ""}
                      </span>
                    </span>
                    <Money value={a.balance} className={cx("text-[13px]", a.balance < 0 && "text-negative")} />
                    <ChevronRight size={14} className="text-faint" />
                  </Link>
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

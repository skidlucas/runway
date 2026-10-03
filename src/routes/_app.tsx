import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useState } from "react"
import { CommandPalette } from "~/components/command-palette"
import { AppUi, Fab, Sidebar, TabBar } from "~/components/shell"
import { TransactionEntry } from "~/components/transaction-entry"
import { q } from "~/lib/queries"
import { getAuthState } from "~/server/fns/auth"

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    const { authed } = await getAuthState()
    if (!authed) throw redirect({ to: "/login" })
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(q.accounts()),
  component: AppLayout,
})

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
}

function AppLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [entry, setEntry] = useState<{ open: boolean; accountId?: string; categoryId?: string }>({ open: false })

  const openNewTransaction = useCallback(
    (defaults?: { accountId?: string; categoryId?: string }) => setEntry({ open: true, ...defaults }),
    [],
  )
  const ui = useMemo(() => ({ openPalette: () => setPaletteOpen(true), openNewTransaction }), [openNewTransaction])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "n" || e.key === "N") {
        e.preventDefault()
        openNewTransaction()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [openNewTransaction])

  return (
    <AppUi.Provider value={ui}>
      <div className="grid min-h-dvh grid-cols-[232px_minmax(0,1fr)] max-[1100px]:grid-cols-[56px_minmax(0,1fr)] max-md:grid-cols-1">
        <div className="max-md:hidden">
          <Sidebar />
        </div>
        <main className="flex min-w-0 flex-col max-md:pb-[100px]">
          <Outlet />
        </main>
      </div>
      <TabBar />
      <Fab />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <TransactionEntry
        open={entry.open}
        onOpenChange={(open) => setEntry((s) => ({ ...s, open }))}
        defaults={{ accountId: entry.accountId, categoryId: entry.categoryId }}
      />
    </AppUi.Provider>
  )
}

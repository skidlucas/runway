import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useState } from "react"
import { CommandPalette } from "~/components/command-palette"
import { AppUi, Fab, Sidebar, TabBar } from "~/components/shell"
import { TransactionEntry } from "~/components/transaction-entry"
import { q } from "~/lib/queries"
import { clientTimeZone, localToday, shortcutBlocked } from "~/lib/hooks"
import { getAuthState } from "~/server/fns/auth"
import { syncSchedules } from "~/server/fns/planning"

// Due schedules are booked by an explicit POST once a day per tab, not by the data reads:
// a read (preload on hover, refetch on focus) must not write.
let schedulesSyncedOn: string | null = null

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    const { authed } = await getAuthState()
    if (!authed) throw redirect({ to: "/login" })
    const today = localToday()
    if (schedulesSyncedOn !== today) {
      schedulesSyncedOn = today
      await syncSchedules({ data: { timeZone: clientTimeZone() } }).catch(() => {
        schedulesSyncedOn = null
      })
    }
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(q.accounts()),
  component: AppLayout,
})

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
      if (shortcutBlocked(e)) return
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

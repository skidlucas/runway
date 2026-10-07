import { useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useState } from "react"
import { CommandPalette } from "~/components/command-palette"
import { AppUi, Fab, Sidebar, TabBar } from "~/components/shell"
import { TransactionEntry } from "~/components/transaction-entry"
import { isSignedIn } from "~/lib/auth"
import { q, refreshAfter } from "~/lib/queries"
import { clientTimeZone, shortcutBlocked, useToday } from "~/lib/hooks"
import { syncSchedules } from "~/server/fns/planning"

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    if (!(await isSignedIn())) throw redirect({ to: "/login" })
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(q.accounts()),
  component: AppLayout,
})

// Due schedules are booked by an explicit POST once a day per tab, not by the data reads: a read
// (preload on hover, refetch on focus) must not write. It runs in the browser after the page
// shows, so it never delays a navigation; what it books then refreshes the data on screen.
let schedulesSyncedOn: string | null = null

function useScheduleSync() {
  const client = useQueryClient()
  const today = useToday()
  useEffect(() => {
    if (schedulesSyncedOn === today) return
    schedulesSyncedOn = today
    syncSchedules({ data: { timeZone: clientTimeZone() } })
      .then(({ posted, matched, converted }) => (posted + matched + converted > 0 ? refreshAfter(client, ["transactions", "schedules"]) : undefined))
      .catch(() => {
        schedulesSyncedOn = null
      })
  }, [client, today])
}

function AppLayout() {
  useScheduleSync()
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
      <a
        href="#main"
        className="sr-only rounded-[6px] border border-line bg-panel px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50"
      >
        Aller au contenu
      </a>
      <div className="grid min-h-dvh grid-cols-[232px_minmax(0,1fr)] max-[1100px]:grid-cols-[56px_minmax(0,1fr)] max-md:grid-cols-1">
        <div className="max-md:hidden">
          <Sidebar />
        </div>
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-col outline-none max-md:pb-[100px]">
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

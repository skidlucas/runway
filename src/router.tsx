import { QueryCache, QueryClient } from "@tanstack/react-query"
import { createRouter } from "@tanstack/react-router"
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query"
import { ErrorView, NotFoundView } from "./components/errors"
import { getToasts, toast } from "./components/toast"
import { leaveIfSignedOut } from "./lib/auth"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: reportQueryError }),
    defaultOptions: {
      queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 },
    },
  })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: ErrorView,
    defaultNotFoundComponent: NotFoundView,
    scrollRestoration: true,
  })
  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}

/**
 * Says so when data fails to load, wherever the screen would otherwise stay on its skeleton.
 * Client only: the toast list is module state, shared by every request on the server.
 */
const reportQueryError = (error: Error) => {
  if (typeof window === "undefined" || leaveIfSignedOut(error)) return
  const message = `Chargement impossible : ${error.message || "erreur inconnue"}`
  // Several widgets failing together for the same reason make one toast.
  if (getToasts().some((t) => t.message === message)) return
  toast(message, { tone: "error" })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}

import { getAuthState } from "~/server/fns/auth"

// Browser only: on the server, module state is shared by every request.
let signedIn = false

/**
 * Whether this browser has a session. The browser asks the server once, then trusts the answer
 * for its navigations and preloads: a session ended meanwhile (logged out everywhere, password
 * changed) shows up as the next server call refused, which `leaveIfSignedOut` handles.
 */
export const isSignedIn = async () => {
  if (typeof window === "undefined") return (await getAuthState()).authed
  if (!signedIn) signedIn = (await getAuthState()).authed
  return signedIn
}

/** Sends the browser to the login page when `error` is a server call refused for lack of session. */
export const leaveIfSignedOut = (error: unknown) => {
  if (typeof window === "undefined" || !(error instanceof Error) || error.message !== "UNAUTHORIZED") return false
  signedIn = false
  if (window.location.pathname !== "/login") window.location.assign("/login")
  return true
}

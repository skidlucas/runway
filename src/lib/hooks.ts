import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeader } from "@tanstack/react-start/server"
import { useEffect, useState, useSyncExternalStore } from "react"
import { todayIn } from "~/domain/dates"

const subscribeMedia = (query: string) => (cb: () => void) => {
  const mql = window.matchMedia(query)
  mql.addEventListener("change", cb)
  return () => mql.removeEventListener("change", cb)
}

/** Below 768 px the app switches to its mobile layout. */
// The server cannot measure the viewport: guess from the user agent on both sides, so phones
// render (and hydrate) the mobile layout directly instead of flashing the desktop one.
const looksMobile = createIsomorphicFn()
  .server(() => /Mobi|Android|iPhone/i.test(getRequestHeader("user-agent") ?? ""))
  .client(() => /Mobi|Android|iPhone/i.test(navigator.userAgent))

export function useIsMobile() {
  return useSyncExternalStore(
    subscribeMedia("(max-width: 767px)"),
    () => window.matchMedia("(max-width: 767px)").matches,
    looksMobile,
  )
}

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris"
  } catch {
    return "Europe/Paris"
  }
}

// Workers run in UTC: server rendering assumes the default zone, which the browser then
// reports to the server (see the /_app route) so both agree on "today".
export const localTimeZone = createIsomorphicFn()
  .server(() => "Europe/Paris")
  .client(browserTimeZone)

/** The browser's zone, or undefined while rendering on the server. */
export const clientTimeZone = createIsomorphicFn()
  .server((): string | undefined => undefined)
  .client(browserTimeZone)

export const localToday = () => todayIn(localTimeZone())

/** Today's date, refreshed when the tab comes back after midnight. */
export function useToday() {
  const [today, setToday] = useState(localToday)
  useEffect(() => {
    const refresh = () => setToday(localToday())
    window.addEventListener("focus", refresh)
    const id = window.setInterval(refresh, 60_000)
    return () => {
      window.removeEventListener("focus", refresh)
      window.clearInterval(id)
    }
  }, [])
  return today
}

export function useDebounced<T>(value: T, delay = 200) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(id)
  }, [value, delay])
  return debounced
}

/**
 * Whether a single-key shortcut should be ignored: the user is typing, holds a modifier, or a
 * dialog, menu or popover is open (arrows and letters belong to it, not to the page behind).
 */
export const shortcutBlocked = (e: KeyboardEvent) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return true
  const el = e.target as HTMLElement | null
  if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return true
  return document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]') !== null
}

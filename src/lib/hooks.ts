import { useEffect, useState, useSyncExternalStore } from "react"
import { todayIn } from "~/domain/dates"

const subscribeMedia = (query: string) => (cb: () => void) => {
  const mql = window.matchMedia(query)
  mql.addEventListener("change", cb)
  return () => mql.removeEventListener("change", cb)
}

/** Below 768 px the app switches to its mobile layout. SSR renders the desktop layout. */
export function useIsMobile() {
  return useSyncExternalStore(
    subscribeMedia("(max-width: 767px)"),
    () => window.matchMedia("(max-width: 767px)").matches,
    () => false,
  )
}

export const localTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris"
  } catch {
    return "Europe/Paris"
  }
}

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

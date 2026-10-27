import { useWindowVirtualizer, type VirtualItem } from "@tanstack/react-virtual"
import * as React from "react"

const PREFETCH_ROWS = 40

/**
 * Renders only the rows near the viewport: the page scrolls as a whole (sticky header and
 * sidebar), so the list follows the window and its offset from the top of the page.
 */
export function useWindowList(options: {
  count: number
  estimateSize: (index: number) => number
  getItemKey: (index: number) => string
  onReachEnd?: () => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = React.useState(0)
  const measure = React.useCallback(() => {
    const el = ref.current
    if (el) setScrollMargin(Math.round(el.getBoundingClientRect().top + window.scrollY))
  }, [])
  // Whatever sits above the list (bulk bar, balances loading) moves it down and grows the page.
  React.useLayoutEffect(measure, [measure])
  React.useEffect(() => {
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    return () => observer.disconnect()
  }, [measure])
  // The server renders the top of the list, but a reload restores the scroll before hydration: rendering
  // from it would not match the server's HTML, and React would rebuild the whole page. The first render
  // starts at 0, then this moves to the real position before the virtualizer attaches to the window,
  // which scrolls to its offset (declared first so it runs first).
  React.useLayoutEffect(() => {
    if (window.scrollY === 0) return
    virtualizer.scrollOffset = window.scrollY
    virtualizer.measure()
  }, [])
  const virtualizer = useWindowVirtualizer({
    count: options.count,
    estimateSize: options.estimateSize,
    getItemKey: options.getItemKey,
    overscan: 10,
    scrollMargin,
    initialRect: { width: 0, height: 900 },
    initialOffset: 0,
  })
  const items = virtualizer.getVirtualItems()
  const last = items.at(-1)?.index ?? -1
  const { count, onReachEnd } = options
  React.useEffect(() => {
    if (count > 0 && last >= count - PREFETCH_ROWS) onReachEnd?.()
  }, [last, count, onReachEnd])
  return { ref, virtualizer, items, offset: (item: VirtualItem) => item.start - scrollMargin }
}

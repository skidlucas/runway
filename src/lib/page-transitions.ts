import { tabOf } from "~/components/shell"

type LocationChange = { fromLocation?: { pathname: string }; toLocation: { pathname: string }; pathChanged: boolean }

/** Read by the CSS animations of `app.css`, through `:active-view-transition-type()`. */
type PageTransition = "tab" | "push" | "back"

// Back and forward come from the browser: on iOS the swipe-back gesture already slides the page,
// and animating it again on top makes it jump.
let fromHistory = false
if (typeof window !== "undefined") window.addEventListener("popstate", () => (fromHistory = true))

/** 0 on a tab's own page, then one level per path segment: /accounts → /accounts/:id goes one deeper. */
const depth = (path: string) => (tabOf(path)?.to === path ? 0 : path.split("/").filter(Boolean).length)

const typesOf = ({ fromLocation, toLocation, pathChanged }: LocationChange): PageTransition[] | false => {
  const popped = fromHistory
  fromHistory = false
  if (!fromLocation || !pathChanged || popped) return false
  if (!window.matchMedia("(max-width: 767px)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false
  const from = fromLocation.pathname
  const to = toLocation.pathname
  if (tabOf(from) !== tabOf(to)) return ["tab"]
  const delta = depth(to) - depth(from)
  return [delta > 0 ? "push" : delta < 0 ? "back" : "tab"]
}

/**
 * Mobile only: tabs cross-fade, a page opened from another slides in from the right. Off where the
 * browser cannot tell the kinds of transition apart: the router would then animate every change
 * of the URL, down to the search typed in a register.
 */
export const pageTransitions = () =>
  typeof window !== "undefined" && CSS.supports("selector(:active-view-transition-type(a))") ? { types: typesOf } : false

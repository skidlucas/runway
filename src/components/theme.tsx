import * as React from "react"
import { Segmented } from "./ui"

export type ThemePref = "system" | "light" | "dark"

const read = (): ThemePref => {
  try {
    const v = localStorage.getItem("runway-theme")
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

/** The browser bar (theme-color) takes the page background of the theme in use. */
const syncThemeColor = () => {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg)
}

export const applyTheme = (pref: ThemePref) => {
  try {
    localStorage.setItem("runway-theme", pref)
  } catch {}
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.dataset.theme = dark ? "dark" : "light"
  syncThemeColor()
}

/** Mounted once at the root: follows a change of the system theme on every page, not only where the setting is shown. */
export function useThemeSync() {
  React.useEffect(() => {
    syncThemeColor()
    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => {
      if (read() === "system") applyTheme("system")
    }
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
}

export function ThemeControl() {
  const [pref, setPref] = React.useState<ThemePref>("system")
  React.useEffect(() => setPref(read()), [])
  return (
    <Segmented
      value={pref}
      onChange={(p) => {
        setPref(p)
        applyTheme(p)
      }}
      options={[
        { value: "system", label: "Système" },
        { value: "light", label: "Clair" },
        { value: "dark", label: "Sombre" },
      ]}
    />
  )
}

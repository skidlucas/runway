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

export const applyTheme = (pref: ThemePref) => {
  try {
    localStorage.setItem("runway-theme", pref)
  } catch {}
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.dataset.theme = dark ? "dark" : "light"
}

export function ThemeControl() {
  const [pref, setPref] = React.useState<ThemePref>("system")
  React.useEffect(() => setPref(read()), [])
  React.useEffect(() => {
    if (pref !== "system") return
    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => applyTheme("system")
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [pref])
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

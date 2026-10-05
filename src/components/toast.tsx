import { X } from "lucide-react"
import * as React from "react"
import { leaveIfSignedOut } from "~/lib/auth"
import { cx, IconButton } from "./ui"

type Toast = { id: number; message: string; tone: "default" | "error"; action?: { label: string; run: () => void } }

let toasts: Toast[] = []
let nextId = 1
// A toast being read or reached with the keyboard keeps the rest of its time until it is let go.
const timers = new Map<number, { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }>()
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export const toast = (message: string, options: { tone?: Toast["tone"]; action?: Toast["action"]; duration?: number } = {}) => {
  const id = nextId++
  toasts = [...toasts, { id, message, tone: options.tone ?? "default", ...(options.action ? { action: options.action } : {}) }]
  emit()
  timers.set(id, { handle: null, remaining: options.duration ?? (options.tone === "error" ? 6000 : 3500), startedAt: 0 })
  holdToast(id, false)
}

export const toastError = (error: unknown) => {
  if (leaveIfSignedOut(error)) return
  toast(error instanceof Error ? error.message : "Une erreur est survenue", { tone: "error" })
}

export const getToasts = () => toasts

/** Pauses (held) or resumes the countdown of a toast. */
export const holdToast = (id: number, held: boolean) => {
  const timer = timers.get(id)
  if (!timer) return
  if (held && timer.handle) {
    clearTimeout(timer.handle)
    timer.handle = null
    timer.remaining -= Date.now() - timer.startedAt
  } else if (!held && !timer.handle) {
    timer.startedAt = Date.now()
    timer.handle = setTimeout(() => dismiss(id), timer.remaining)
  }
}

const dismiss = (id: number) => {
  const handle = timers.get(id)?.handle
  if (handle) clearTimeout(handle)
  timers.delete(id)
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function Toaster() {
  const list = React.useSyncExternalStore(subscribe, getToasts, getToasts)
  return (
    // One live region that is always there: screen readers often skip a region that appears
    // already filled, which would hide the undo offer of a deletion.
    <div role="status" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-md:bottom-[96px] max-md:left-4">
      {list.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}

function ToastItem({ toast: t }: { toast: Toast }) {
  const held = React.useRef({ hover: false, focus: false })
  const hold = (patch: Partial<typeof held.current>) => {
    held.current = { ...held.current, ...patch }
    holdToast(t.id, held.current.hover || held.current.focus)
  }
  return (
    <div
      onMouseEnter={() => hold({ hover: true })}
      onMouseLeave={() => hold({ hover: false })}
      onFocus={() => hold({ focus: true })}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) hold({ focus: false })
      }}
      className={cx(
        "animate-pop pointer-events-auto flex min-w-[260px] max-w-[420px] items-center gap-3 rounded-[10px] border bg-elevated px-3.5 py-2.5 shadow-[var(--shadow-modal)]",
        t.tone === "error" ? "border-negative/40 text-negative" : "border-line-control text-fg",
      )}
    >
      <span className="flex-1">{t.message}</span>
      {t.action ? (
        <button
          type="button"
          className="font-medium text-accent-fg"
          onClick={() => {
            t.action?.run()
            dismiss(t.id)
          }}
        >
          {t.action.label}
        </button>
      ) : null}
      <IconButton label="Fermer" size="sm" onClick={() => dismiss(t.id)}>
        <X size={13} />
      </IconButton>
    </div>
  )
}

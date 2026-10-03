import { X } from "lucide-react"
import { useSyncExternalStore } from "react"
import { cx, IconButton } from "./ui"

type Toast = { id: number; message: string; tone: "default" | "error"; action?: { label: string; run: () => void } }

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

export const toast = (message: string, options: { tone?: Toast["tone"]; action?: Toast["action"]; duration?: number } = {}) => {
  const id = nextId++
  toasts = [...toasts, { id, message, tone: options.tone ?? "default", ...(options.action ? { action: options.action } : {}) }]
  emit()
  setTimeout(() => dismiss(id), options.duration ?? (options.tone === "error" ? 6000 : 3500))
}

export const toastError = (error: unknown) =>
  toast(error instanceof Error ? error.message : "Une erreur est survenue", { tone: "error" })

const dismiss = (id: number) => {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => toasts, () => toasts)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-md:bottom-[96px] max-md:left-4">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
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
      ))}
    </div>
  )
}

import { env } from "./env"
import { useSession } from "@tanstack/react-start/server"
import { runApp } from "./runtime"
import { SessionEpoch } from "./services/session-epoch"

// `key` ties the cookie to the current password: changing APP_PASSWORD signs every device out.
// `epoch` does the same on demand, from the settings ("Se déconnecter de tous les appareils").
type SessionData = { authed?: boolean; key?: string; epoch?: number }

export const appSession = () =>
  useSession<SessionData>({
    // The __Host- prefix makes browsers refuse the cookie unless it is Secure, on "/" and without
    // a Domain: a sibling subdomain cannot plant its own session cookie.
    name: "__Host-runway_session",
    password: env.SESSION_SECRET,
    maxAge: 60 * 60 * 24 * 30,
    sessionHeader: false,
    cookie: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
  })

const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))

export const passwordKey = async () =>
  Array.from((await sha256(`runway-session|${env.APP_PASSWORD ?? ""}`)).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")

// Checked on every authenticated request, so each isolate keeps the epoch for a short while:
// signing out everywhere reaches the other isolates within this delay.
const EPOCH_TTL_MS = 30_000
let epochCache: { value: number; readAt: number } | undefined

export const currentEpoch = async () => {
  const now = Date.now()
  if (epochCache && now - epochCache.readAt < EPOCH_TTL_MS) return epochCache.value
  const value = await runApp(SessionEpoch.use((s) => s.current))
  epochCache = { value, readAt: now }
  return value
}

/** Invalidates every session cookie issued so far, on every device. */
export const revokeAllSessions = async () => {
  const value = await runApp(SessionEpoch.use((s) => s.bump))
  epochCache = { value, readAt: Date.now() }
}

export const isAuthed = async (data: SessionData) =>
  data.authed === true && data.key === (await passwordKey()) && (data.epoch ?? 0) === (await currentEpoch())

/** Constant-time comparison so the password cannot be guessed character by character. */
export const passwordMatches = async (candidate: string) => {
  const expected = env.APP_PASSWORD
  if (!expected) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(candidate)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

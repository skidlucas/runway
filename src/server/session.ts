import { env } from "./env"
import { useSession } from "@tanstack/react-start/server"

// `key` ties the cookie to the current password: changing APP_PASSWORD signs every device out.
type SessionData = { authed?: boolean; key?: string }

export const appSession = () =>
  useSession<SessionData>({
    name: "runway_session",
    password: env.SESSION_SECRET,
    maxAge: 60 * 60 * 24 * 30,
    sessionHeader: false,
    cookie: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
  })

const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))

export const passwordKey = async () =>
  Array.from((await sha256(`runway-session|${env.APP_PASSWORD ?? ""}`)).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")

export const isAuthed = async (data: SessionData) => data.authed === true && data.key === (await passwordKey())

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

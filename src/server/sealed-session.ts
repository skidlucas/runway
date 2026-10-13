import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server"
import { defaults, seal, unseal } from "iron-webcrypto"

type CookieOptions = NonNullable<Parameters<typeof setCookie>[2]>

export type SealedSessionConfig = {
  name: string
  /** At least 32 characters. */
  password: string
  /** Lifetime in seconds, counted from when the session was created. */
  maxAge: number
  cookie?: CookieOptions
}

type StoredSession<T> = { id: string; createdAt: number; data: T }

/**
 * Encrypted + signed session in an httpOnly cookie. Replaces the `useSession` removed in
 * TanStack Start 1.169, with the same iron format as its h3 implementation: cookies issued
 * before the upgrade stay valid.
 */
export const openSealedSession = async <T extends object>(config: SealedSessionConfig) => {
  const sealOptions = { ...defaults, ttl: config.maxAge * 1000 }
  const cookieOptions: CookieOptions = { path: "/", secure: true, httpOnly: true, ...config.cookie }

  let stored: StoredSession<Partial<T>> | undefined
  const sealed = getCookie(config.name)
  if (sealed) {
    try {
      const unsealed = (await unseal(sealed, config.password, sealOptions)) as StoredSession<Partial<T>>
      if (Date.now() - unsealed.createdAt <= config.maxAge * 1000) stored = unsealed
    } catch {
      // Tampered, expired or sealed with another secret: start from an empty session.
    }
  }

  const session = {
    data: stored?.data ?? ({} as Partial<T>),
    update: async (update: Partial<T>) => {
      stored ??= { id: crypto.randomUUID(), createdAt: Date.now(), data: {} }
      Object.assign(stored.data, update)
      session.data = stored.data
      setCookie(config.name, await seal(stored, config.password, sealOptions), {
        ...cookieOptions,
        expires: new Date(stored.createdAt + config.maxAge * 1000),
      })
    },
    clear: async () => {
      stored = undefined
      session.data = {}
      deleteCookie(config.name, cookieOptions)
    },
  }
  return session
}

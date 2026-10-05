import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { env, runApp } = vi.hoisted(() => ({ env: { APP_PASSWORD: "" as string | undefined }, runApp: vi.fn() }))
vi.mock("~/server/env", () => ({ env }))
vi.mock("~/server/runtime", () => ({ runApp }))

// The epoch is cached per isolate (module state): each test starts from a fresh module.
const load = async () => {
  vi.resetModules()
  return import("~/server/session")
}

beforeEach(() => {
  env.APP_PASSWORD = "correct horse"
  runApp.mockReset()
  runApp.mockResolvedValue(0)
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-04T10:00:00Z"))
})
afterEach(() => {
  vi.useRealTimers()
})

describe("session cookie", () => {
  it("accepts a cookie sealed for the current password, including one issued before epochs existed", async () => {
    const s = await load()
    const key = await s.passwordKey()
    expect(await s.isAuthed({ authed: true, key, epoch: 0 })).toBe(true)
    expect(await s.isAuthed({ authed: true, key })).toBe(true)
  })

  it("refuses a cookie that is not signed in, or sealed for another password", async () => {
    const s = await load()
    const key = await s.passwordKey()
    expect(await s.isAuthed({})).toBe(false)
    expect(await s.isAuthed({ authed: false, key, epoch: 0 })).toBe(false)
    expect(await s.isAuthed({ authed: true, epoch: 0 })).toBe(false)
    env.APP_PASSWORD = "new password"
    expect(await s.passwordKey()).not.toBe(key)
    expect(await s.isAuthed({ authed: true, key, epoch: 0 })).toBe(false)
  })

  it("signs out every cookie at once when the epoch goes up, in this isolate right away", async () => {
    const s = await load()
    const key = await s.passwordKey()
    expect(await s.isAuthed({ authed: true, key, epoch: 0 })).toBe(true)
    runApp.mockResolvedValueOnce(1)
    await s.revokeAllSessions()
    expect(await s.isAuthed({ authed: true, key, epoch: 0 })).toBe(false)
    expect(await s.isAuthed({ authed: true, key })).toBe(false)
    expect(await s.isAuthed({ authed: true, key, epoch: 1 })).toBe(true)
  })

  it("sees a sign-out made by another isolate within 30 seconds, reading the epoch once meanwhile", async () => {
    const s = await load()
    const key = await s.passwordKey()
    expect(await s.isAuthed({ authed: true, key, epoch: 0 })).toBe(true)
    expect(runApp).toHaveBeenCalledTimes(1)

    runApp.mockResolvedValue(1)
    vi.setSystemTime(new Date("2026-10-04T10:00:29Z"))
    expect(await s.isAuthed({ authed: true, key, epoch: 0 })).toBe(true)
    expect(runApp).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date("2026-10-04T10:00:31Z"))
    expect(await s.isAuthed({ authed: true, key, epoch: 0 })).toBe(false)
    expect(runApp).toHaveBeenCalledTimes(2)
  })

  it("accepts at once a cookie sealed after a sign-out made by another isolate", async () => {
    const s = await load()
    const key = await s.passwordKey()
    expect(await s.isAuthed({ authed: true, key, epoch: 0 })).toBe(true)
    runApp.mockResolvedValue(1)
    expect(await s.isAuthed({ authed: true, key, epoch: 1 })).toBe(true)
    expect(await s.isAuthed({ authed: true, key, epoch: 0 })).toBe(false)
    expect(runApp).toHaveBeenCalledTimes(2)
  })
})

describe("password check", () => {
  it("matches only the configured password", async () => {
    const s = await load()
    expect(await s.passwordMatches("correct horse")).toBe(true)
    expect(await s.passwordMatches("correct hors")).toBe(false)
    expect(await s.passwordMatches("correct horse ")).toBe(false)
  })

  it("lets nobody in when no password is configured", async () => {
    const s = await load()
    for (const missing of ["", undefined]) {
      env.APP_PASSWORD = missing
      expect(await s.passwordMatches("")).toBe(false)
      expect(await s.passwordMatches("anything")).toBe(false)
    }
  })
})

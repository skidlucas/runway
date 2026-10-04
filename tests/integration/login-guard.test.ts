import { Effect } from "effect"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { clientKey, LoginGuard } from "~/server/services/login-guard"
import { createHarness, type Harness } from "./harness"

const MINUTES_15 = 15 * 60 * 1000

describe("LoginGuard", () => {
  let h: Harness
  beforeAll(async () => {
    h = await createHarness()
  }, 60_000)
  afterAll(() => h?.dispose())
  beforeEach(async () => {
    await h.d1.prepare("DELETE FROM login_attempts").run()
  })

  const attempt = (client: string, now: number) => h.run(LoginGuard.use((g) => g.attempt(client, now)))
  const attempts = async (client: string, now: number, count: number) => {
    for (let i = 0; i < count; i++) await attempt(client, now)
  }

  it("locks a client after ten attempts, even sent in parallel, then unlocks after 15 minutes", async () => {
    const now = 1_000_000
    const results = await h.run(
      Effect.all(
        Array.from({ length: 10 }, () => LoginGuard.use((g) => g.attempt("ip:1.1.1.1", now))),
        { concurrency: "unbounded" },
      ),
    )
    expect(results.every((r) => r === null)).toBe(true)
    const locked = await attempt("ip:1.1.1.1", now + 1)
    expect(locked).toBe(now + 1 + MINUTES_15)
    expect(await attempt("ip:1.1.1.1", now + 60_000)).toBe(locked)
    expect(await attempt("ip:1.1.1.1", locked! + 1)).toBeNull()
  })

  it("only locks the client that made the attempts", async () => {
    await attempts("ip:6.6.6.6", 2_000_000, 11)
    expect(await attempt("ip:6.6.6.6", 2_000_001)).not.toBeNull()
    expect(await attempt("ip:7.7.7.7", 2_000_001)).toBeNull()
  })

  it("forgets attempts older than the window", async () => {
    await attempts("ip:2.2.2.2", 3_000_000, 10)
    expect(await attempt("ip:2.2.2.2", 3_000_000 + MINUTES_15)).toBeNull()
    await attempts("ip:2.2.2.2", 3_000_000 + MINUTES_15, 8)
    expect(await attempt("ip:2.2.2.2", 3_000_000 + MINUTES_15)).toBeNull()
  })

  it("starts over after a successful login", async () => {
    await attempts("ip:3.3.3.3", 5_000_000, 9)
    await h.run(LoginGuard.use((g) => g.succeeded("ip:3.3.3.3")))
    await attempts("ip:3.3.3.3", 5_000_000, 9)
    expect(await attempt("ip:3.3.3.3", 5_000_000)).toBeNull()
  })

  it("locks everyone once guesses spread over many clients reach the global ceiling", async () => {
    const now = 7_000_000
    for (let i = 0; i < 100; i++) expect(await attempt(`ip:10.0.0.${i}`, now)).toBeNull()
    expect(await attempt("ip:10.0.1.1", now)).toBe(now + MINUTES_15)
    expect(await attempt("ip:10.0.1.2", now + 1)).toBe(now + MINUTES_15)
    expect(await attempt("ip:10.0.1.3", now + MINUTES_15)).toBeNull()
  })

  it("does not count a locked client's attempts towards the global ceiling", async () => {
    const now = 9_000_000
    await attempts("ip:4.4.4.4", now, 200)
    expect(await attempt("ip:5.5.5.5", now)).toBeNull()
  })

  it("drops expired counters", async () => {
    await attempts("ip:8.8.8.8", 11_000_000, 3)
    await attempt("ip:9.9.9.9", 11_000_000 + MINUTES_15)
    const keys = await h.d1.prepare("SELECT key FROM login_attempts ORDER BY key").all<{ key: string }>()
    expect(keys.results.map((r) => r.key)).toEqual(["global", "ip:9.9.9.9"])
  })
})

describe("clientKey", () => {
  it("keys IPv4 by address and IPv6 by /64 prefix", () => {
    expect(clientKey("203.0.113.7")).toBe("ip:203.0.113.7")
    expect(clientKey("2001:db8:0:1:aaaa::1")).toBe("ip:2001:db8:0:1::/64")
    expect(clientKey("2001:0db8:0000:0001:ffff:1:2:3")).toBe("ip:2001:db8:0:1::/64")
    expect(clientKey("2001:db8::1")).toBe("ip:2001:db8:0:0::/64")
    expect(clientKey(undefined)).toBe("ip:unknown")
    expect(clientKey("")).toBe("ip:unknown")
  })
})

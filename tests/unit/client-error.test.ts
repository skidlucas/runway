import { describe, expect, it } from "vitest"
import { clientError } from "~/server/errors"

describe("clientError", () => {
  it("keeps the message but not the stack, which server functions would send to the browser", () => {
    const error = clientError("UNAUTHORIZED")
    expect(error.message).toBe("UNAUTHORIZED")
    expect(Object.keys(Object.getOwnPropertyDescriptors(error))).not.toContain("stack")
    expect(error.stack).toBeUndefined()
  })
})

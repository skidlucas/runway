import { afterEach, describe, expect, it, vi } from "vitest"
import { clientError, Invalid, NotFound, toClientError, UNEXPECTED_ERROR } from "~/server/errors"

const keys = (error: Error) => Object.keys(Object.getOwnPropertyDescriptors(error))

describe("clientError", () => {
  it("keeps the message but not the stack, which server functions would send to the browser", () => {
    const error = clientError("UNAUTHORIZED")
    expect(error.message).toBe("UNAUTHORIZED")
    expect(keys(error)).not.toContain("stack")
    expect(error.stack).toBeUndefined()
  })
})

describe("toClientError", () => {
  afterEach(() => vi.restoreAllMocks())

  it("passes an error already meant for the browser through", () => {
    const error = clientError("UNAUTHORIZED")
    expect(toClientError(error)).toBe(error)
  })

  it("keeps the French message of a business failure, without its stack", () => {
    for (const failure of [new Invalid({ message: "Montant invalide" }), new NotFound({ entity: "Compte", id: "x" })]) {
      const error = toClientError(failure)
      expect(error.message).toBe(failure.message)
      expect(keys(error)).not.toContain("stack")
    }
  })

  it("replaces anything else, such as a rejected input, by a generic message and logs it", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const rejected = new Error(JSON.stringify([{ message: "Expected string", path: ["password"] }]))
    const error = toClientError(rejected)
    expect(error.message).toBe(UNEXPECTED_ERROR)
    expect(keys(error)).not.toContain("stack")
    expect(log).toHaveBeenCalledWith(rejected)
  })
})

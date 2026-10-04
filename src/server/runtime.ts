import { env } from "./env"
import { Cause, type Effect, Exit, type Layer, ManagedRuntime, Option } from "effect"
import { makeAppLayer } from "./app-layer"
import { clientError, ExternalError, Invalid, NotFound } from "./errors"

type AppServices = Layer.Success<ReturnType<typeof makeAppLayer>>

// The D1 binding and secrets are stable for the life of the isolate, so one runtime is reused.
let runtime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined

const getRuntime = () => {
  runtime ??= ManagedRuntime.make(makeAppLayer(env))
  return runtime
}

const isUserFacing = (error: unknown): error is NotFound | Invalid | ExternalError =>
  error instanceof NotFound || error instanceof Invalid || error instanceof ExternalError

/**
 * Runs an effect for a server function. Business errors keep their French message;
 * anything else is logged and replaced by a generic message.
 */
export const runApp = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> => {
  const exit = await getRuntime().runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isSome(error) && isUserFacing(error.value)) {
    // The user only sees a French summary: the provider's own error (revoked key, rate limit,
    // HTTP status) has to reach the Workers logs.
    if (error.value instanceof ExternalError) console.warn(`[${error.value.service}] ${error.value.message}`, error.value.cause)
    throw clientError(error.value.message)
  }
  console.error(Cause.pretty(exit.cause))
  throw clientError("Une erreur inattendue est survenue")
}

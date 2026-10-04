import { env } from "./env"
import { Cause, type Effect, Exit, type Layer, ManagedRuntime, Option } from "effect"
import { makeAppLayer } from "./app-layer"
import { clientError, ExternalError, Invalid, NotFound, userMessageOf } from "./errors"

type AppServices = Layer.Success<ReturnType<typeof makeAppLayer>>

// The D1 binding and secrets are stable for the life of the isolate, so one runtime is reused.
let runtime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined

const getRuntime = () => {
  runtime ??= ManagedRuntime.make(makeAppLayer(env))
  return runtime
}

/**
 * Runs an effect for a server function. Business errors keep their French message;
 * anything else is logged and replaced by a generic message.
 */
export const runApp = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> => {
  const exit = await getRuntime().runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
  // The user only sees a French summary: the provider's own error (revoked key, rate limit,
  // HTTP status) and database failures have to reach the Workers logs.
  if (failure instanceof ExternalError) console.warn(`[${failure.service}] ${failure.message}`, failure.cause)
  else if (!(failure instanceof NotFound || failure instanceof Invalid)) console.error(Cause.pretty(exit.cause))
  throw clientError(userMessageOf(failure) ?? "Une erreur inattendue est survenue")
}

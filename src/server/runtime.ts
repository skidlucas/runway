import { env } from "cloudflare:workers"
import { Cause, type Effect, Exit, type Layer, ManagedRuntime, Option } from "effect"
import { makeAppLayer } from "./app-layer"
import { ExternalError, Invalid, NotFound } from "./errors"

type AppServices = Layer.Success<ReturnType<typeof makeAppLayer>>

// The D1 binding and secrets are stable for the life of the isolate, so one runtime is reused.
let runtime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined

const getRuntime = () => {
  runtime ??= ManagedRuntime.make(makeAppLayer(env as unknown as Cloudflare.Env))
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
  if (Option.isSome(error) && isUserFacing(error.value)) throw new Error(error.value.message)
  console.error(Cause.pretty(exit.cause))
  throw new Error("Une erreur inattendue est survenue")
}

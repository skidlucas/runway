import { Schema } from "effect"

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: Schema.String,
  id: Schema.String,
}) {
  override get message() {
    return `${this.entity} introuvable (${this.id})`
  }
}

/** A business rule refused the operation; `message` is shown to the user as is. */
export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", {
  message: Schema.String,
}) {}

export class ExternalError extends Schema.TaggedError<ExternalError>()("ExternalError", {
  service: Schema.String,
  message: Schema.String,
  rateLimited: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {}

const FOREIGN_KEY_FAILED = "FOREIGN KEY constraint failed"

// D1's message is wrapped by drizzle ("Failed query: …"), so the whole cause chain is searched.
const isForeignKeyViolation = (error: unknown, depth = 0): boolean =>
  depth < 5 &&
  typeof error === "object" &&
  error !== null &&
  ((error instanceof Error && error.message.includes(FOREIGN_KEY_FAILED)) ||
    isForeignKeyViolation((error as { cause?: unknown }).cause, depth + 1))

/**
 * The French message a failure shows to the user, or null when only the logs should know.
 * A foreign key violation means the operation points at something deleted meanwhile, often
 * from another tab: reloading fixes it.
 */
export const userMessageOf = (error: unknown): string | null => {
  if (error instanceof NotFound || error instanceof Invalid || error instanceof ExternalError) return error.message
  if (isForeignKeyViolation(error)) return "Un élément lié a été supprimé entre-temps. Recharge la page et réessaie."
  return null
}

/**
 * An error thrown out of a server function. Its message reaches the client, its stack would too
 * (server functions serialize own properties), so the stack is dropped: it only shows server paths.
 */
export const clientError = (message: string) => {
  const error = new Error(message)
  delete error.stack
  return error
}

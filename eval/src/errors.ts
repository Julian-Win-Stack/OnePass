// The two kinds of failure the command has.
//
// Everything the eval refuses — an unset corpus, a proxy that does not build, a baseline key it
// cannot read, a run label that was never written — is a message telling the person what to
// change, so it prints as that message and nothing else. Anything else is a bug, and prints as
// a stack. One class carries the first kind rather than one per module, because the only thing
// a caller ever asks is which of the two it is.

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}

/** A mistake in the command line, which is answered with the usage text as well. */
export class UsageError extends EvalError {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** What went wrong, from anything that might be thrown. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

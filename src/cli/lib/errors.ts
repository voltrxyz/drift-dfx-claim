// Adapted from voltr-integration-scripts apps/cli/src/lib/errors.ts (19072d0).

/**
 * A user-facing error. Its message is printed without a stack trace, so use it
 * for problems the operator can fix (bad flag, missing keypair, wrong mode)
 * rather than internal bugs.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Top-level error handler for the CLI. Known, actionable errors print just
 * their message; anything unexpected prints `Error: <message>` and only shows a
 * stack trace when DEBUG is set. Always exits non-zero.
 */
export function reportError(error: unknown): never {
  if (error instanceof CliError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
  } else {
    console.error("Error:", error);
  }
  process.exit(1);
}

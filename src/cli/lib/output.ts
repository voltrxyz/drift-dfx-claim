// Adapted from voltr-integration-scripts apps/cli/src/lib/output.ts (19072d0).
/**
 * Shared output formatting for the CLI. Transaction modes print their own
 * structured output from the core processor; these helpers cover everything
 * else (validation summaries, query results, ad-hoc key/value reporting) so
 * commands look consistent without re-implementing formatting each time.
 */

/** Print a JSON-serializable value with stable two-space indentation. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Print a blank line or a plain line of text. */
export function printLine(line = ""): void {
  console.log(line);
}

/** Print an indented `label  value` row with the label padded to a column. */
export function printField(
  label: string,
  value: string,
  labelWidth = 24,
): void {
  console.log(`  ${label.padEnd(labelWidth)}${value}`);
}

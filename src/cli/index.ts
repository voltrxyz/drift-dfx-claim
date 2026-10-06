// Adapted from voltr-integration-scripts apps/cli/src/index.ts (19072d0).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerCheckCommand } from "./commands/check.js";
import { registerDfxCommands } from "./commands/dfx.js";
import { reportError } from "./lib/errors.js";
import { addGlobalOptions } from "./lib/globals.js";

export function createProgram(): Command {
  const program = new Command()
    .name("drift-dfx-claim")
    .description(
      "Claim DFX for Voltr Drift strategies through the vault's initialize_strategy instruction.",
    )
    .showHelpAfterError("(run with --help for usage)");
  addGlobalOptions(program);
  registerCheckCommand(program);
  registerDfxCommands(program);
  program.addHelpText(
    "after",
    "\nRun via pnpm: pnpm cli -- --profile configs/my-vault.json dfx:status\nDefault mode is print. The manager or vault admin may claim.",
  );
  return program;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  try {
    await createProgram().parseAsync(args, { from: "user" });
  } catch (error) {
    reportError(error);
  }
}

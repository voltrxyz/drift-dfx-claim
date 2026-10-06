// Adapted from voltr-integration-scripts apps/cli/src/commands/check.ts (19072d0).
import type { Command } from "commander";
import { loadProfile } from "../../core/profile.js";
import { requireProfilePath, type GlobalOptions } from "../lib/globals.js";
import { printField, printLine } from "../lib/output.js";

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .summary("validate the profile offline, without RPC or a keypair")
    .action(async () => {
      const profile = await loadProfile(
        requireProfilePath(program.opts<GlobalOptions>(), { command: "check" }),
      );
      printLine(
        `Profile: ${profile.name ?? "(unnamed)"} (${profile.cluster ?? "cluster not set"})`,
      );
      printField("vaultAddress", profile.vault.vaultAddress);
      printField(
        "lookupTable",
        profile.vault.useLookupTable
          ? profile.vault.lookupTableAddress!
          : "(disabled)",
      );
      printLine(
        "Profile is valid. Cluster and deployment state are not checked offline.",
      );
    });
}

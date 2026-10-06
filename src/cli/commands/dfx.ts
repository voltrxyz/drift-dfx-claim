import { Option, type Command } from "commander";
import {
  resolveLookupTableAddresses,
  requireVaultAddress,
} from "../../core/profile.js";
import {
  processOperation,
  type ProcessOperationArgs,
} from "../../core/tx/processor.js";
import {
  buildDfxSetupOperation,
  buildDfxClaimOperation,
} from "../../dfx/operations.js";
import { deriveDfxStrategyAccounts } from "../../dfx/pda.js";
import { queryDfxStatus } from "../../dfx/queries.js";
import {
  DFX_UPGRADE_HINT,
  getErrorLogs,
  hasDfxUpgradeError,
} from "../../dfx/errors.js";
import { loadCommandContext, resolveProcessorOptions } from "../lib/globals.js";
import { addRoleKeypairOption, loadDfxManager } from "../lib/signers.js";
import { parseAddress } from "../lib/parse.js";
import { printField, printJson, printLine } from "../lib/output.js";
import { loadEligibility } from "../lib/eligibility.js";
import { CliError } from "../lib/errors.js";

interface StrategyOptions {
  strategy: string;
  managerKeypair?: string;
  recipient?: string;
}
interface ClaimOptions extends StrategyOptions {
  recipientTokenAccount?: string;
  distributor?: string;
  eligibilityFile?: string;
}

async function processDfxOperation(args: ProcessOperationArgs): Promise<void> {
  try {
    const result = await processOperation(args);
    if (result.mode === "simulate" && result.simulation.err) {
      const hint = hasDfxUpgradeError(result.simulation.logs)
        ? ` ${DFX_UPGRADE_HINT}`
        : "";
      throw new CliError(`Simulation failed; no transaction was sent.${hint}`);
    }
  } catch (error) {
    if (hasDfxUpgradeError(getErrorLogs(error))) {
      throw new CliError(
        `${error instanceof Error ? error.message : String(error)}\nHint: ${DFX_UPGRADE_HINT}`,
      );
    }
    throw error;
  }
}

export function registerDfxCommands(program: Command): void {
  program
    .command("dfx:status")
    .summary(
      "show Drift strategies, DFX allocations, claim status and claimant ATA balances",
    )
    .description(
      "Read-only; no signer. Discovers this vault's Drift strategies unless --strategy is supplied.",
    )
    .option("--strategy <address>", "query only this Drift strategy")
    .option(
      "--eligibility-file <path>",
      "read eligibility JSON instead of the public API",
    )
    .option("--json", "print structured JSON")
    .action(
      async (options: {
        strategy?: string;
        eligibilityFile?: string;
        json?: boolean;
      }) => {
        const strategy = options.strategy
          ? parseAddress(options.strategy, "--strategy")
          : undefined;
        const { ctx, profile } = await loadCommandContext(program);
        const result = await queryDfxStatus(ctx, {
          vault: requireVaultAddress(profile),
          strategy,
          loadEligibility: (claimant) =>
            loadEligibility({ claimant, file: options.eligibilityFile }),
        });
        if (options.json) {
          printJson(result);
          return;
        }
        printLine(`Vault: ${result.vault}`);
        if (result.strategies.length === 0)
          printLine("No Drift strategies found.");
        for (const status of result.strategies) {
          printLine(`Strategy: ${status.strategy}`);
          printField("vault_strategy_auth", status.vaultStrategyAuth);
          printField("claimant DFX ATA", status.claimantTokenAccount.address);
          printField(
            "ATA balance",
            status.claimantTokenAccount.exists
              ? `${status.claimantTokenAccount.balanceDfx} DFX (${status.claimantTokenAccount.balanceBaseUnits} base units)`
              : "missing; run dfx:setup",
          );
          if (!status.allocations.length)
            printField("allocation", "no allocation");
          for (const allocation of status.allocations) {
            printField("distributor", allocation.distributor);
            printField(
              "allocation",
              `${allocation.amountDfx} DFX (${allocation.amountBaseUnits} base units)`,
            );
            printField("claimed", allocation.claimed ? "yes" : "no");
            printField("ClaimStatus", allocation.claimStatus);
          }
        }
      },
    );

  addRoleKeypairOption(
    program
      .command("dfx:setup")
      .summary(
        "create the claimant DFX ATA and optional recipient ATA in one setup transaction",
      )
      .description(
        "Idempotent token-account setup. Supports PDA owners and multisig mode without a keypair.",
      )
      .requiredOption("--strategy <address>", "Drift strategy address")
      .option(
        "--recipient <owner>",
        "also create this owner's DFX ATA (PDA owners allowed)",
      ),
    "manager",
  ).action(async (options: StrategyOptions) => {
    const strategy = parseAddress(options.strategy, "--strategy");
    const recipient = options.recipient
      ? parseAddress(options.recipient, "--recipient")
      : undefined;
    const { ctx, profile, globals } = await loadCommandContext(program);
    const processorOptions = resolveProcessorOptions(globals);
    const { manager, payer } = await loadDfxManager(
      globals,
      options.managerKeypair,
    );
    const operation = await buildDfxSetupOperation(ctx, {
      manager,
      vault: requireVaultAddress(profile),
      strategy,
      recipient,
      lookupTableAddresses: resolveLookupTableAddresses(profile),
    });
    await processDfxOperation({
      ctx,
      payer,
      operation,
      mode: globals.mode,
      options: processorOptions,
    });
  });

  addRoleKeypairOption(
    program
      .command("dfx:claim")
      .summary(
        "claim and forward the full DFX allocation to the selected recipient",
      )
      .description(
        "Signs as vault manager OR admin. Preflight checks run in every mode; token accounts must already exist. Use dfx:setup first.",
      )
      .requiredOption("--strategy <address>", "Drift strategy address")
      .addOption(
        new Option(
          "--recipient <owner>",
          "recipient owner; resolve its DFX ATA",
        ).conflicts("recipientTokenAccount"),
      )
      .addOption(
        new Option(
          "--recipient-token-account <address>",
          "existing recipient DFX token account",
        ).conflicts("recipient"),
      )
      .option(
        "--distributor <address>",
        "select a distributor when there are multiple unclaimed allocations",
      )
      .option(
        "--eligibility-file <path>",
        "read eligibility JSON instead of the public API",
      ),
    "manager",
  ).action(async (options: ClaimOptions) => {
    if (!options.recipient && !options.recipientTokenAccount) {
      throw new CliError(
        "Provide exactly one of --recipient or --recipient-token-account.",
      );
    }
    const strategy = parseAddress(options.strategy, "--strategy");
    const recipient = options.recipient
      ? parseAddress(options.recipient, "--recipient")
      : undefined;
    const recipientTokenAccount = options.recipientTokenAccount
      ? parseAddress(options.recipientTokenAccount, "--recipient-token-account")
      : undefined;
    const distributor = options.distributor
      ? parseAddress(options.distributor, "--distributor")
      : undefined;
    const { ctx, profile, globals } = await loadCommandContext(program);
    const processorOptions = resolveProcessorOptions(globals);
    const { manager, payer } = await loadDfxManager(
      globals,
      options.managerKeypair,
    );
    const vault = requireVaultAddress(profile);
    const { claimant } = await deriveDfxStrategyAccounts(vault, strategy);
    const eligibility = await loadEligibility({
      claimant,
      file: options.eligibilityFile,
    });
    const operation = await buildDfxClaimOperation(ctx, {
      manager,
      vault,
      strategy,
      recipient,
      recipientTokenAccount,
      distributor,
      eligibility,
      lookupTableAddresses: resolveLookupTableAddresses(profile),
    });
    await processDfxOperation({
      ctx,
      payer,
      operation,
      mode: globals.mode,
      options: processorOptions,
    });
  });
}

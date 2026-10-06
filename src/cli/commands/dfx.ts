import { Option, type Command } from "commander";
import {
  processOperation,
  type ProcessOperationArgs,
} from "../../core/tx/processor.js";
import {
  buildDfxSetupOperation,
  buildDfxClaimOperation,
} from "../../dfx/operations.js";
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
import { createEligibilityLoader } from "../lib/eligibility.js";
import { resolveDfxStrategy } from "../lib/strategy.js";
import { CliError } from "../lib/errors.js";

interface StrategyOptions {
  vault: string;
  strategy?: string;
  managerKeypair?: string;
  recipient?: string;
  lookupTable?: string;
  distributor?: string;
  eligibilityFile?: string;
}
interface ClaimOptions extends StrategyOptions {
  recipientTokenAccount?: string;
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
    .requiredOption("--vault <address>", "Voltr vault address")
    .option("--strategy <address>", "query only this Drift strategy")
    .option(
      "--eligibility-file <path>",
      "read eligibility JSON instead of the public API",
    )
    .option("--json", "print structured JSON")
    .action(
      async (options: {
        vault: string;
        strategy?: string;
        eligibilityFile?: string;
        json?: boolean;
      }) => {
        const vault = parseAddress(options.vault, "--vault");
        const strategy = options.strategy
          ? parseAddress(options.strategy, "--strategy")
          : undefined;
        const { ctx } = loadCommandContext(program);
        const result = await queryDfxStatus(ctx, {
          vault,
          strategy,
          loadEligibility: createEligibilityLoader({
            file: options.eligibilityFile,
          }),
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
              : `missing; run dfx:setup --vault ${vault} --strategy ${status.strategy}`,
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
      .requiredOption("--vault <address>", "Voltr vault address")
      .option(
        "--strategy <address>",
        "Drift strategy (auto-select from unclaimed DFX allocations if omitted)",
      )
      .option("--lookup-table <address>", "existing address lookup table")
      .option(
        "--distributor <address>",
        "limit strategy auto-selection to this distributor",
      )
      .option(
        "--eligibility-file <path>",
        "read eligibility JSON for auto-selection instead of the public API",
      )
      .option(
        "--recipient <owner>",
        "also create this owner's DFX ATA (PDA owners allowed)",
      ),
    "manager",
  ).action(async (options: StrategyOptions) => {
    const vault = parseAddress(options.vault, "--vault");
    const strategyFilter = options.strategy
      ? parseAddress(options.strategy, "--strategy")
      : undefined;
    const lookupTableAddresses = options.lookupTable
      ? [parseAddress(options.lookupTable, "--lookup-table")]
      : [];
    const distributor = options.distributor
      ? parseAddress(options.distributor, "--distributor")
      : undefined;
    const recipient = options.recipient
      ? parseAddress(options.recipient, "--recipient")
      : undefined;
    const { ctx, globals } = loadCommandContext(program);
    const processorOptions = resolveProcessorOptions(globals);
    const { manager, payer } = await loadDfxManager(
      globals,
      options.managerKeypair,
    );
    const { strategy } = await resolveDfxStrategy(ctx, {
      vault,
      strategy: strategyFilter,
      distributor,
      loadEligibility: createEligibilityLoader({
        file: options.eligibilityFile,
      }),
    });
    const operation = await buildDfxSetupOperation(ctx, {
      manager,
      vault,
      strategy,
      recipient,
      lookupTableAddresses,
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
      .requiredOption("--vault <address>", "Voltr vault address")
      .option(
        "--strategy <address>",
        "Drift strategy (auto-select from unclaimed DFX allocations if omitted)",
      )
      .option("--lookup-table <address>", "existing address lookup table")
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
    const vault = parseAddress(options.vault, "--vault");
    if (!options.recipient && !options.recipientTokenAccount) {
      throw new CliError(
        "Provide exactly one of --recipient or --recipient-token-account.",
      );
    }
    const strategyFilter = options.strategy
      ? parseAddress(options.strategy, "--strategy")
      : undefined;
    const lookupTableAddresses = options.lookupTable
      ? [parseAddress(options.lookupTable, "--lookup-table")]
      : [];
    const recipient = options.recipient
      ? parseAddress(options.recipient, "--recipient")
      : undefined;
    const recipientTokenAccount = options.recipientTokenAccount
      ? parseAddress(options.recipientTokenAccount, "--recipient-token-account")
      : undefined;
    const distributor = options.distributor
      ? parseAddress(options.distributor, "--distributor")
      : undefined;
    const { ctx, globals } = loadCommandContext(program);
    const processorOptions = resolveProcessorOptions(globals);
    const { manager, payer } = await loadDfxManager(
      globals,
      options.managerKeypair,
    );
    const loadEligibility = createEligibilityLoader({
      file: options.eligibilityFile,
    });
    const { strategy, claimant } = await resolveDfxStrategy(ctx, {
      vault,
      strategy: strategyFilter,
      distributor,
      loadEligibility,
    });
    const eligibility = await loadEligibility(claimant);
    const operation = await buildDfxClaimOperation(ctx, {
      manager,
      vault,
      strategy,
      recipient,
      recipientTokenAccount,
      distributor,
      eligibility,
      lookupTableAddresses,
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

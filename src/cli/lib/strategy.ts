import type { Address } from "@solana/kit";
import type { ScriptContext } from "../../core/types.js";
import { deriveDfxStrategyAccounts } from "../../dfx/pda.js";
import { queryDfxStatus, type DfxStatusArgs } from "../../dfx/queries.js";
import { CliError } from "./errors.js";
import { printLine } from "./output.js";

export async function resolveDfxStrategy(
  ctx: ScriptContext,
  args: DfxStatusArgs & { distributor?: Address },
): Promise<{ strategy: Address; claimant: Address }> {
  if (args.strategy) {
    const { claimant } = await deriveDfxStrategyAccounts(
      args.vault,
      args.strategy,
    );
    return { strategy: args.strategy, claimant };
  }

  const status = await queryDfxStatus(ctx, args);
  const candidates = status.strategies
    .map((strategy) => ({
      ...strategy,
      allocations: strategy.allocations.filter(
        (allocation) =>
          !allocation.claimed &&
          (!args.distributor || allocation.distributor === args.distributor),
      ),
    }))
    .filter((strategy) => strategy.allocations.length > 0);

  if (candidates.length === 0) {
    throw new CliError(
      `No unclaimed DFX allocation was found for any Drift strategy of vault ${args.vault}${args.distributor ? ` in distributor ${args.distributor}` : ""}. Run dfx:status --vault ${args.vault}.`,
    );
  }
  const describe = (candidate: (typeof candidates)[number]) =>
    `${candidate.strategy} (vault_strategy_auth ${candidate.vaultStrategyAuth}, ${candidate.allocations.map((allocation) => `${allocation.amountDfx} DFX in distributor ${allocation.distributor}`).join(", ")})`;
  if (candidates.length > 1) {
    throw new CliError(
      `Multiple Drift strategies have unclaimed DFX allocations. Pass --strategy <address> to select one:\n${candidates.map((candidate) => `  ${describe(candidate)}`).join("\n")}`,
    );
  }
  const selected = candidates[0]!;
  printLine(`Selected strategy ${describe(selected)}`);
  return { strategy: selected.strategy, claimant: selected.vaultStrategyAuth };
}

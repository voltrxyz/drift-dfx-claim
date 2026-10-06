import {
  fetchEncodedAccount,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import {
  getStrategyInitReceiptSize,
  VOLTR_VAULT_PROGRAM_ADDRESS,
} from "@voltr/vault-sdk";
import type { ScriptContext } from "../core/types.js";
import {
  decodeDriftStrategyReceipt,
  loadDriftStrategyReceipt,
  readDfxTokenAccount,
} from "./accounts.js";
import { DFX_MINT, DRIFT_ADAPTOR_PROGRAM_ID, formatDfx } from "./constants.js";
import { isInitializedClaimStatus } from "./distributor.js";
import { deriveClaimStatus, deriveDfxStrategyAccounts } from "./pda.js";
import type { DfxEligibilityEntry } from "./types.js";

export interface DfxStatusArgs {
  vault: Address;
  strategy?: Address;
  /** CLI-owned HTTP/file loader, injected so queries remain independent of transport. */
  loadEligibility: (claimant: Address) => Promise<Array<DfxEligibilityEntry>>;
}

export async function queryDfxStatus(ctx: ScriptContext, args: DfxStatusArgs) {
  const strategies = args.strategy
    ? [args.strategy]
    : await discoverStrategies(ctx, args.vault);
  const statuses = [];
  for (const strategy of strategies) {
    const { claimant, strategyInitReceipt, claimantTokenAccount } =
      await deriveDfxStrategyAccounts(args.vault, strategy);
    if (args.strategy)
      await loadDriftStrategyReceipt(
        ctx.rpc,
        strategyInitReceipt,
        args.vault,
        strategy,
      );
    const entries = (await args.loadEligibility(claimant)).filter(
      (entry) => entry.mint === DFX_MINT,
    );
    if (entries.some((entry) => entry.claimant !== claimant))
      throw new Error(`Eligibility claimant does not match ${claimant}.`);
    const token = await readDfxTokenAccount(
      ctx.rpc,
      claimantTokenAccount,
      "Claimant DFX ATA",
    );
    if (token && token.owner !== claimant)
      throw new Error(
        `Claimant DFX ATA ${claimantTokenAccount} has the wrong owner.`,
      );
    const allocations = [];
    for (const entry of entries) {
      const claimStatus = await deriveClaimStatus(claimant, entry.distributor);
      const status = await fetchEncodedAccount(ctx.rpc, claimStatus, {
        commitment: "confirmed",
      });
      allocations.push({
        distributor: entry.distributor,
        claimStatus,
        claimed: isInitializedClaimStatus(status),
        amountDfx: formatDfx(entry.amountUnlocked),
        amountBaseUnits: entry.amountUnlocked.toString(),
        lockedAmountBaseUnits: entry.amountLocked.toString(),
      });
    }
    statuses.push({
      strategy,
      vaultStrategyAuth: claimant,
      claimantTokenAccount: {
        address: claimantTokenAccount,
        exists: token !== null,
        balanceDfx: formatDfx(token?.amount ?? 0n),
        balanceBaseUnits: (token?.amount ?? 0n).toString(),
      },
      allocations,
      allocationStatus: allocations.length ? "allocated" : "no allocation",
    });
  }
  return { vault: args.vault, strategies: statuses };
}

async function discoverStrategies(
  ctx: ScriptContext,
  vault: Address,
): Promise<Array<Address>> {
  const accounts = await ctx.rpc
    .getProgramAccounts(VOLTR_VAULT_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: BigInt(getStrategyInitReceiptSize()) },
        // SDK layout: discriminator (8), vault (32), strategy (32), adaptor (32).
        {
          memcmp: {
            offset: 8n,
            bytes: vault as unknown as Base58EncodedBytes,
            encoding: "base58",
          },
        },
        {
          memcmp: {
            offset: 72n,
            bytes: DRIFT_ADAPTOR_PROGRAM_ID as unknown as Base58EncodedBytes,
            encoding: "base58",
          },
        },
      ],
    })
    .send();
  return [
    ...new Set(
      accounts.map(({ account }) => {
        if (account.owner !== VOLTR_VAULT_PROGRAM_ADDRESS)
          throw new Error("StrategyInitReceipt has an invalid program owner.");
        return decodeDriftStrategyReceipt(
          Buffer.from(account.data[0], "base64"),
          vault,
        ).strategy;
      }),
    ),
  ].sort();
}

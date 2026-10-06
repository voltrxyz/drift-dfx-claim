import {
  fetchEncodedAccount,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getInitializeStrategyInstructionAsync } from "@voltr/vault-sdk";
import {
  readonlyAccount,
  writableAccount,
  withRemainingAccounts,
} from "../core/account-meta.js";
import { setupTokenAccount } from "../core/token/accounts.js";
import type { BuiltOperation, ScriptContext } from "../core/types.js";
import {
  loadDfxVault,
  loadDriftStrategyReceipt,
  fetchOwnedAccount,
  readDfxTokenAccount,
} from "./accounts.js";
import {
  DFX_DISCRIMINATOR,
  DFX_MINT,
  DRIFT_ADAPTOR_PROGRAM_ID,
  MERKLE_DISTRIBUTOR_PROGRAM_ID,
  formatDfx,
} from "./constants.js";
import {
  decodeMerkleDistributor,
  encodeDfxAdditionalArgs,
  isInitializedClaimStatus,
  verifyDfxProof,
} from "./distributor.js";
import {
  deriveClaimStatus,
  deriveDfxAta,
  deriveDfxStrategyAccounts,
} from "./pda.js";
import type { DfxEligibilityEntry } from "./types.js";

export interface DfxSetupArgs {
  manager: TransactionSigner;
  vault: Address;
  strategy: Address;
  recipient?: Address;
  lookupTableAddresses?: Array<Address>;
}

export async function buildDfxSetupOperation(
  _ctx: ScriptContext,
  args: DfxSetupArgs,
): Promise<BuiltOperation> {
  const { claimant } = await deriveDfxStrategyAccounts(
    args.vault,
    args.strategy,
  );
  if (args.recipient === claimant)
    throw new Error("Recipient owner must differ from vault_strategy_auth.");
  const instructions: Array<Instruction> = [];
  const claimantTokenAccount = await setupTokenAccount({
    payer: args.manager,
    mint: DFX_MINT,
    owner: claimant,
    instructions,
  });
  const metadata: Record<string, string> = { claimant, claimantTokenAccount };
  if (args.recipient) {
    metadata.recipientTokenAccount = await setupTokenAccount({
      payer: args.manager,
      mint: DFX_MINT,
      owner: args.recipient,
      instructions,
    });
  }
  return {
    label: "dfx:setup",
    instructions,
    lookupTableAddresses: args.lookupTableAddresses,
    metadata,
  };
}

export interface DfxClaimArgs {
  /** The manager or admin; also the fee/rent payer. A noop signer in multisig mode. */
  manager: TransactionSigner;
  vault: Address;
  strategy: Address;
  recipient?: Address;
  recipientTokenAccount?: Address;
  distributor?: Address;
  eligibility: Array<DfxEligibilityEntry>;
  lookupTableAddresses?: Array<Address>;
}

async function selectAllocation(
  ctx: ScriptContext,
  args: DfxClaimArgs,
  claimant: Address,
) {
  const entries = args.eligibility.filter((entry) => entry.mint === DFX_MINT);
  if (entries.some((entry) => entry.claimant !== claimant)) {
    throw new Error(
      `Eligibility claimant does not match vault_strategy_auth ${claimant}.`,
    );
  }
  const candidates = args.distributor
    ? entries.filter((entry) => entry.distributor === args.distributor)
    : entries;
  if (candidates.length === 0) {
    throw new Error(
      `No DFX allocation for claimant ${claimant}${args.distributor ? ` in distributor ${args.distributor}` : " (API 404 means no allocation)"}.`,
    );
  }
  if (
    new Set(candidates.map((entry) => entry.distributor)).size !==
    candidates.length
  ) {
    throw new Error(
      "Eligibility contains duplicate distributor entries; use an unambiguous eligibility response.",
    );
  }
  const statuses = await Promise.all(
    candidates.map(async (entry) => {
      const claimStatus = await deriveClaimStatus(claimant, entry.distributor);
      const account = await fetchEncodedAccount(ctx.rpc, claimStatus, {
        commitment: "confirmed",
      });
      return { entry, claimStatus, claimed: isInitializedClaimStatus(account) };
    }),
  );
  const unclaimed = statuses.filter((status) => !status.claimed);
  if (unclaimed.length === 0) {
    throw new Error(
      `DFX already claimed: ${statuses.map((status) => `distributor ${status.entry.distributor}, ClaimStatus ${status.claimStatus}`).join("; ")}.`,
    );
  }
  if (unclaimed.length > 1) {
    throw new Error(
      `Multiple unclaimed DFX allocations. Select --distributor from: ${unclaimed.map(({ entry }) => `${entry.distributor} (${formatDfx(entry.amountUnlocked)} DFX)`).join(", ")}.`,
    );
  }
  return unclaimed[0]!;
}

export async function buildDfxClaimOperation(
  ctx: ScriptContext,
  args: DfxClaimArgs,
): Promise<BuiltOperation> {
  if (Boolean(args.recipient) === Boolean(args.recipientTokenAccount)) {
    throw new Error(
      "Provide exactly one of --recipient or --recipient-token-account.",
    );
  }
  const vault = await loadDfxVault(ctx.rpc, args.vault);
  if (
    args.manager.address !== vault.manager &&
    args.manager.address !== vault.admin
  ) {
    throw new Error(
      `Signing address ${args.manager.address} is not the vault manager (${vault.manager}) or admin (${vault.admin}).`,
    );
  }
  const { claimant, strategyInitReceipt, claimantTokenAccount } =
    await deriveDfxStrategyAccounts(args.vault, args.strategy);
  await loadDriftStrategyReceipt(
    ctx.rpc,
    strategyInitReceipt,
    args.vault,
    args.strategy,
  );
  const { entry, claimStatus } = await selectAllocation(ctx, args, claimant);
  const account = await fetchOwnedAccount(
    ctx.rpc,
    entry.distributor,
    MERKLE_DISTRIBUTOR_PROGRAM_ID,
    "Distributor",
  );
  const distributor = decodeMerkleDistributor(account.data);
  if (distributor.mint !== DFX_MINT)
    throw new Error(
      `Distributor ${entry.distributor} mint is not DFX (${DFX_MINT}).`,
    );
  if (distributor.clawedBack)
    throw new Error(`Distributor ${entry.distributor} has been clawed back.`);
  if (entry.amountLocked !== 0n)
    throw new Error(
      "DFX locked_amount must be zero; this command only forwards the unlocked allocation.",
    );

  const slot = await ctx.rpc.getSlot({ commitment: "confirmed" }).send();
  if (distributor.enableSlot > slot)
    throw new Error(
      `Distributor is not enabled until slot ${distributor.enableSlot}; current slot is ${slot}.`,
    );
  const now = await ctx.rpc.getBlockTime(slot).send();
  if (now === null)
    throw new Error(
      `RPC has no block time for slot ${slot}; cannot safely check the claim window. Retry with an RPC that serves block times.`,
    );
  if (distributor.startTs > now || distributor.endTs > now) {
    throw new Error(
      `Refusing early claim: distributor start_ts=${distributor.startTs}, end_ts=${distributor.endTs}, cluster time=${now}. Wait until both timestamps have passed; claiming early forfeits part of the allocation.`,
    );
  }
  if (!verifyDfxProof(entry, distributor.root)) {
    throw new Error(
      `Merkle proof mismatch for claimant ${claimant} and distributor ${entry.distributor}; check the eligibility amount and proof.`,
    );
  }

  const setupHint = " Run dfx:setup --strategy " + args.strategy + ".";
  const claimantToken = await readDfxTokenAccount(
    ctx.rpc,
    claimantTokenAccount,
    "Claimant DFX token account",
    setupHint,
  );
  if (!claimantToken)
    throw new Error(
      `Claimant DFX token account ${claimantTokenAccount} does not exist.${setupHint}`,
    );
  if (claimantToken.owner !== claimant)
    throw new Error(
      `Claimant DFX token account owner must be vault_strategy_auth ${claimant}.${setupHint}`,
    );

  const recipientTokenAccount =
    args.recipientTokenAccount ?? (await deriveDfxAta(args.recipient!));
  const recipientToken = await readDfxTokenAccount(
    ctx.rpc,
    recipientTokenAccount,
    "Recipient DFX token account",
  );
  if (!recipientToken) {
    throw new Error(
      `Recipient DFX token account ${recipientTokenAccount} does not exist. Run dfx:setup --strategy ${args.strategy} --recipient <owner>, or supply an existing DFX token account.`,
    );
  }
  if (recipientToken.owner === claimant)
    throw new Error(
      `Recipient token account owner must differ from vault_strategy_auth ${claimant}.`,
    );
  if (args.recipient && recipientToken.owner !== args.recipient)
    throw new Error(
      `Recipient ATA owner does not match --recipient ${args.recipient}.`,
    );

  const tokenVault = await readDfxTokenAccount(
    ctx.rpc,
    distributor.tokenVault,
    "Distributor token vault",
  );
  if (!tokenVault)
    throw new Error(
      `Distributor token vault ${distributor.tokenVault} does not exist.`,
    );
  if (
    tokenVault.owner !== entry.distributor ||
    distributor.tokenVault !== (await deriveDfxAta(entry.distributor))
  ) {
    throw new Error(
      "Distributor token vault must be the distributor's DFX ATA.",
    );
  }
  if (tokenVault.amount < entry.amountUnlocked) {
    throw new Error(
      `Distributor token vault balance ${tokenVault.amount} is below allocation ${entry.amountUnlocked} base units.`,
    );
  }

  const instruction = await getInitializeStrategyInstructionAsync({
    payer: args.manager,
    manager: args.manager,
    vault: args.vault,
    strategy: args.strategy,
    adaptorProgram: DRIFT_ADAPTOR_PROGRAM_ID,
    instructionDiscriminator: new Uint8Array(DFX_DISCRIMINATOR.CLAIM_DFX),
    additionalArgs: encodeDfxAdditionalArgs(entry),
  });
  return {
    label: "dfx:claim",
    instructions: [
      withRemainingAccounts(instruction, [
        writableAccount(entry.distributor),
        writableAccount(claimStatus),
        writableAccount(distributor.tokenVault),
        writableAccount(claimantTokenAccount),
        writableAccount(recipientTokenAccount),
        readonlyAccount(MERKLE_DISTRIBUTOR_PROGRAM_ID),
        readonlyAccount(TOKEN_PROGRAM_ADDRESS),
      ]),
    ],
    lookupTableAddresses: args.lookupTableAddresses,
    metadata: {
      claimant,
      distributor: entry.distributor,
      claimStatus,
      allocationDfx: formatDfx(entry.amountUnlocked),
      allocationBaseUnits: entry.amountUnlocked.toString(),
      claimantTokenAccount,
      recipientTokenAccount,
    },
  };
}

import {
  fetchEncodedAccount,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  AccountState,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  getStrategyInitReceiptDecoder,
  getStrategyInitReceiptSize,
  getVaultDecoder,
  STRATEGY_INIT_RECEIPT_DISCRIMINATOR,
  VAULT_DISCRIMINATOR,
  VOLTR_VAULT_PROGRAM_ADDRESS,
} from "@voltr/vault-sdk";
import type { SolanaRpc } from "../core/types.js";
import { DFX_MINT, DRIFT_ADAPTOR_PROGRAM_ID } from "./constants.js";

export async function fetchOwnedAccount(
  rpc: SolanaRpc,
  accountAddress: Address,
  program: Address,
  label: string,
) {
  const account = await fetchEncodedAccount(rpc, accountAddress, {
    commitment: "confirmed",
  });
  if (!account.exists)
    throw new Error(`${label} ${accountAddress} does not exist.`);
  if (account.programAddress !== program || account.executable) {
    throw new Error(
      `${label} ${accountAddress} must be owned by program ${program}.`,
    );
  }
  return account;
}

function assertDiscriminator(
  data: ReadonlyUint8Array,
  discriminator: ReadonlyUint8Array,
  label: string,
): void {
  if (!Buffer.from(data.subarray(0, 8)).equals(Buffer.from(discriminator))) {
    throw new Error(`${label} has an invalid account discriminator.`);
  }
}

export async function loadDfxVault(rpc: SolanaRpc, vault: Address) {
  const account = await fetchOwnedAccount(
    rpc,
    vault,
    VOLTR_VAULT_PROGRAM_ADDRESS,
    "Vault",
  );
  assertDiscriminator(account.data, VAULT_DISCRIMINATOR, `Vault ${vault}`);
  return getVaultDecoder().decode(account.data);
}

export function decodeDriftStrategyReceipt(
  data: ReadonlyUint8Array,
  vault: Address,
  strategy?: Address,
) {
  assertDiscriminator(
    data,
    STRATEGY_INIT_RECEIPT_DISCRIMINATOR,
    "StrategyInitReceipt",
  );
  if (data.length !== getStrategyInitReceiptSize())
    throw new Error("Invalid StrategyInitReceipt account size.");
  const receipt = getStrategyInitReceiptDecoder().decode(data);
  if (receipt.vault !== vault || (strategy && receipt.strategy !== strategy)) {
    throw new Error(
      "StrategyInitReceipt does not match the selected vault and strategy.",
    );
  }
  if (receipt.adaptorProgram !== DRIFT_ADAPTOR_PROGRAM_ID) {
    throw new Error(
      `StrategyInitReceipt has a different adaptor: ${receipt.adaptorProgram}; expected Drift adaptor ${DRIFT_ADAPTOR_PROGRAM_ID}.`,
    );
  }
  return receipt;
}

export async function loadDriftStrategyReceipt(
  rpc: SolanaRpc,
  receiptAddress: Address,
  vault: Address,
  strategy: Address,
) {
  const account = await fetchOwnedAccount(
    rpc,
    receiptAddress,
    VOLTR_VAULT_PROGRAM_ADDRESS,
    "StrategyInitReceipt",
  );
  return decodeDriftStrategyReceipt(account.data, vault, strategy);
}

export async function readDfxTokenAccount(
  rpc: SolanaRpc,
  tokenAddress: Address,
  label: string,
  hint = "",
) {
  const account = await fetchEncodedAccount(rpc, tokenAddress, {
    commitment: "confirmed",
  });
  if (!account.exists) return null;
  const fail = (reason: string): never => {
    throw new Error(`${label} ${tokenAddress}: ${reason}.${hint}`);
  };
  if (account.programAddress !== TOKEN_PROGRAM_ADDRESS || account.executable) {
    fail(`must be owned by the SPL Token program ${TOKEN_PROGRAM_ADDRESS}`);
  }
  const token = (() => {
    try {
      return getTokenDecoder().decode(account.data);
    } catch {
      return fail("invalid token account data");
    }
  })();
  if (token.mint !== DFX_MINT) fail(`mint must be DFX (${DFX_MINT})`);
  if (token.state !== AccountState.Initialized)
    fail("token account must be initialized and unfrozen");
  return token;
}

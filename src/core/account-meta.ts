// Adapted from voltr-integration-scripts packages/core/src/account-meta.ts (19072d0).
import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
} from "@solana/kit";

/**
 * Adaptor CPIs carry their protocol-specific accounts as trailing remaining
 * accounts after the fixed list the vault SDK builds.
 */

/** A non-signer, read-only remaining account. */
export function readonlyAccount(address: Address): AccountMeta {
  return { address, role: AccountRole.READONLY };
}

/** A non-signer, writable remaining account. */
export function writableAccount(address: Address): AccountMeta {
  return { address, role: AccountRole.WRITABLE };
}

/**
 * Append remaining accounts to a kit instruction, preserving its existing
 * accounts (including any signer entries the SDK placed on it). The metas must
 * already be kit-typed; no web3.js conversion happens here.
 */
export function withRemainingAccounts(
  instruction: Instruction,
  remaining: readonly AccountMeta[],
): Instruction {
  return {
    ...instruction,
    accounts: [...(instruction.accounts ?? []), ...remaining],
  };
}

import type { Address, ReadonlyUint8Array } from "@solana/kit";

/** Parsed API data. The distributor account, proof and ClaimStatus are authoritative. */
export interface DfxEligibilityEntry {
  claimant: Address;
  distributor: Address;
  mint: Address;
  amountUnlocked: bigint;
  amountLocked: bigint;
  proof: Array<ReadonlyUint8Array>;
}

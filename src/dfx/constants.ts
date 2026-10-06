import { address } from "@solana/kit";

export const DRIFT_ADAPTOR_PROGRAM_ID = address(
  "EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP",
);
export const MERKLE_DISTRIBUTOR_PROGRAM_ID = address(
  "distAitdwx9mDm3SaPMtGZRjpXMPUenLhmPwoySV3Hp",
);
export const DFX_MINT = address("dfxQsZjikuu5DGXPgX7yEpRog74HT5cJgytT3i5iLtw");
export const DFX_DECIMALS = 6;
export const DFX_ELIGIBILITY_API = "https://dfx.drift.trade/api/eligibility";

// Anchor discriminators from the adaptor and merkle distributor sources.
export const DFX_DISCRIMINATOR = {
  CLAIM_DFX: [4, 248, 191, 35, 18, 146, 249, 134],
  MERKLE_DISTRIBUTOR: [77, 119, 139, 70, 84, 247, 12, 26],
  CLAIM_STATUS: [22, 183, 249, 157, 247, 95, 150, 96],
} as const;

export const DFX_SEEDS = { CLAIM_STATUS: "ClaimStatus" } as const;

export function formatDfx(amount: bigint): string {
  const scale = 10n ** BigInt(DFX_DECIMALS);
  return `${amount / scale}.${(amount % scale).toString().padStart(DFX_DECIMALS, "0")}`;
}

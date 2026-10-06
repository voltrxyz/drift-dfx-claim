import {
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type Address,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  findStrategyInitReceiptPda,
  findVaultStrategyAuthPda,
} from "@voltr/vault-sdk";
import {
  DFX_MINT,
  DFX_SEEDS,
  MERKLE_DISTRIBUTOR_PROGRAM_ID,
} from "./constants.js";

export async function deriveDfxStrategyAccounts(
  vault: Address,
  strategy: Address,
) {
  const [[claimant], [strategyInitReceipt]] = await Promise.all([
    findVaultStrategyAuthPda({ vault, strategy }),
    findStrategyInitReceiptPda({ vault, strategy }),
  ]);
  return {
    claimant,
    strategyInitReceipt,
    claimantTokenAccount: await deriveDfxAta(claimant),
  };
}

export async function deriveClaimStatus(
  claimant: Address,
  distributor: Address,
): Promise<Address> {
  const [claimStatus] = await getProgramDerivedAddress({
    programAddress: MERKLE_DISTRIBUTOR_PROGRAM_ID,
    seeds: [
      getUtf8Encoder().encode(DFX_SEEDS.CLAIM_STATUS),
      getAddressEncoder().encode(claimant),
      getAddressEncoder().encode(distributor),
    ],
  });
  return claimStatus;
}

/** Kit's ATA derivation accepts PDA owners, including Squads vaults. */
export async function deriveDfxAta(owner: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner,
    mint: DFX_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

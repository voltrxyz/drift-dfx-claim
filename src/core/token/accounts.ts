// Adapted from voltr-integration-scripts packages/core/src/token/accounts.ts (19072d0).
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token";
import {
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

/**
 * Derives an associated token account and appends its idempotent create
 * instruction. The instruction is an onchain no-op when the account already
 * exists, so operation builders can set up token accounts without an RPC read.
 */
export async function setupTokenAccount(args: {
  payer: TransactionSigner;
  mint: Address;
  owner: Address;
  instructions: Instruction[];
  tokenProgram?: Address;
}): Promise<Address> {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const [ata] = await findAssociatedTokenPda({
    owner: args.owner,
    mint: args.mint,
    tokenProgram,
  });

  args.instructions.push(
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: args.payer,
      owner: args.owner,
      mint: args.mint,
      tokenProgram,
    }),
  );

  return ata;
}

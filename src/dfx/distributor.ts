import { createHash } from "node:crypto";
import {
  fixDecoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getBooleanDecoder,
  getBytesDecoder,
  getI64Decoder,
  getStructDecoder,
  getU8Decoder,
  getU32Encoder,
  getU64Decoder,
  type MaybeEncodedAccount,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { encodeU64Le } from "../core/codec.js";
import { DFX_DISCRIMINATOR, MERKLE_DISTRIBUTOR_PROGRAM_ID } from "./constants.js";
import type { DfxEligibilityEntry } from "./types.js";

// Borsh field order from multi-distributor state/merkle_distributor.rs.
// Read the fixed prefix; closable and reserved buffers follow enableSlot.
export const merkleDistributorDecoder = getStructDecoder([
  ["discriminator", fixDecoderSize(getBytesDecoder(), 8)],
  ["bump", getU8Decoder()],
  ["version", getU64Decoder()],
  ["root", fixDecoderSize(getBytesDecoder(), 32)],
  ["mint", getAddressDecoder()],
  ["tokenVault", getAddressDecoder()],
  ["maxTotalClaim", getU64Decoder()],
  ["maxNumNodes", getU64Decoder()],
  ["totalAmountClaimed", getU64Decoder()],
  ["totalAmountForgone", getU64Decoder()],
  ["numNodesClaimed", getU64Decoder()],
  ["startTs", getI64Decoder()],
  ["endTs", getI64Decoder()],
  ["clawbackStartTs", getI64Decoder()],
  ["clawbackReceiver", getAddressDecoder()],
  ["admin", getAddressDecoder()],
  ["clawedBack", getBooleanDecoder()],
  ["enableSlot", getU64Decoder()],
]);

export function decodeMerkleDistributor(data: ReadonlyUint8Array) {
  if (
    !Buffer.from(data.subarray(0, 8)).equals(
      Buffer.from(DFX_DISCRIMINATOR.MERKLE_DISTRIBUTOR),
    )
  ) {
    throw new Error(
      "Distributor has an invalid MerkleDistributor discriminator.",
    );
  }
  try {
    return merkleDistributorDecoder.decode(data);
  } catch {
    throw new Error(
      "Distributor has invalid or truncated MerkleDistributor account data.",
    );
  }
}

/**
 * True only for a ClaimStatus the distributor initialized. Anyone can send
 * lamports to the PDA, and new_claim's init still succeeds on such a
 * system-owned account, so mere existence does not mean claimed.
 */
export function isInitializedClaimStatus(account: MaybeEncodedAccount): boolean {
  return (
    account.exists &&
    account.programAddress === MERKLE_DISTRIBUTOR_PROGRAM_ID &&
    Buffer.from(account.data.subarray(0, 8)).equals(
      Buffer.from(DFX_DISCRIMINATOR.CLAIM_STATUS),
    )
  );
}

export function encodeDfxAdditionalArgs(
  entry: Pick<DfxEligibilityEntry, "amountUnlocked" | "amountLocked" | "proof">,
): Uint8Array {
  if (entry.proof.some((node) => node.length !== 32)) {
    throw new Error("Each merkle proof node must contain exactly 32 bytes.");
  }
  return new Uint8Array(
    Buffer.concat(
      [
        encodeU64Le(entry.amountUnlocked),
        encodeU64Le(entry.amountLocked),
        getU32Encoder().encode(entry.proof.length),
        ...entry.proof,
      ].map((part) => Buffer.from(part)),
    ),
  );
}

function hash(...parts: Array<ReadonlyUint8Array>): Buffer {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(Buffer.from(part));
  return digest.digest();
}

export function verifyDfxProof(
  entry: DfxEligibilityEntry,
  root: ReadonlyUint8Array,
): boolean {
  let computed = hash(
    new Uint8Array([0]),
    hash(
      getAddressEncoder().encode(entry.claimant),
      encodeU64Le(entry.amountUnlocked),
      encodeU64Le(entry.amountLocked),
    ),
  );
  for (const node of entry.proof) {
    if (node.length !== 32) return false;
    const sibling = Buffer.from(node);
    const [first, second] =
      Buffer.compare(computed, sibling) <= 0
        ? [computed, sibling]
        : [sibling, computed];
    computed = hash(new Uint8Array([1]), first, second);
  }
  return computed.equals(Buffer.from(root));
}

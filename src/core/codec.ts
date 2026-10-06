// Adapted from voltr-integration-scripts packages/core/src/codec.ts (19072d0).
import {
  getU16Encoder,
  getU64Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";

/**
 * Little-endian integer encoders shared by the adapter packages for adaptor
 * `additional_args` / instruction-data fields (e.g. a reward index, a position
 * value, or a borrow rate). These wrap `@solana/kit`'s codecs so every package
 * encodes the same way instead of hand-rolling `DataView` / `BN` calls.
 */

/** Little-endian `u64` bytes. Throws if `value` does not fit in a `u64`. */
export function encodeU64Le(value: bigint): ReadonlyUint8Array {
  return getU64Encoder().encode(value);
}

/** Little-endian `u16` bytes. Throws if `value` does not fit in a `u16`. */
export function encodeU16Le(value: number): ReadonlyUint8Array {
  return getU16Encoder().encode(value);
}

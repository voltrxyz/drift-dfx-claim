// Adapted from voltr-integration-scripts apps/cli/src/lib/parse.ts (19072d0).
import { asAddress, parseBigintAmount } from "../../core/env.js";
import type { Address } from "@solana/kit";
import { CliError } from "./errors.js";

/**
 * Shared coercion for CLI flag values. Every command parses its flags through
 * these helpers so equivalent options (amounts, basis points, indexes, counts,
 * addresses) validate identically and fail with one consistent, actionable
 * `CliError` that names the offending flag. Do not re-implement these per command
 * module — add a parser here instead.
 *
 * The amount and address helpers wrap core's lower-level `parseBigintAmount` /
 * `asAddress` primitives and re-throw a flag-aware `CliError`; the bounded-int
 * helpers (bps / u16 / count / index) have no core equivalent and live here.
 * All parsers take the raw string commander captured plus the flag name (e.g.
 * `"--amount"`) so the error points at exactly what the operator typed.
 */

/**
 * Parse a raw, non-negative integer amount in smallest units (a u64-shaped
 * value: token base units, seconds, a unix timestamp). Returns a `bigint` so no
 * precision is lost for large balances.
 */
export function parseAmount(value: string, flag: string): bigint {
  try {
    return parseBigintAmount(value);
  } catch {
    throw new CliError(
      `${flag} must be a non-negative integer in smallest units: ${value}`,
    );
  }
}

/**
 * Parse a base58 Solana address, reporting the CLI flag when the value is not a
 * valid address. This is the only address parser the CLI uses for flags.
 */
export function parseAddress(value: string, flag: string): Address {
  try {
    return asAddress(value);
  } catch {
    throw new CliError(
      `${flag} must be a valid base58 Solana address: ${value}`,
    );
  }
}

/**
 * Shared bounded non-negative-integer parser backing the basis-point, u16,
 * count, and index helpers. `requirement` completes the sentence
 * `<flag> must be <requirement>: <value>`.
 */
function parseBoundedInt(
  value: string,
  flag: string,
  min: number,
  max: number,
  requirement: string,
): number {
  if (!/^\d+$/.test(value)) {
    throw new CliError(`${flag} must be ${requirement}: ${value}`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new CliError(`${flag} must be ${requirement}: ${value}`);
  }
  return parsed;
}

/** Parse a basis-points value (0..10000). */
export function parseBps(value: string, flag: string): number {
  return parseBoundedInt(
    value,
    flag,
    0,
    10_000,
    "an integer between 0 and 10000",
  );
}

/** Parse an unsigned 16-bit integer (0..65535), e.g. a fee in basis points. */
export function parseU16(value: string, flag: string): number {
  return parseBoundedInt(value, flag, 0, 65_535, "a u16 in the range 0..65535");
}

/** Parse a positive integer count (>= 1), e.g. `--jupiter-max-accounts`. */
export function parseCount(value: string, flag: string): number {
  return parseBoundedInt(
    value,
    flag,
    1,
    Number.MAX_SAFE_INTEGER,
    "a positive integer",
  );
}

/** Parse a non-negative integer index (>= 0), e.g. `--reward-index`. */
export function parseIndex(value: string, flag: string): number {
  return parseBoundedInt(
    value,
    flag,
    0,
    Number.MAX_SAFE_INTEGER,
    "a non-negative integer",
  );
}

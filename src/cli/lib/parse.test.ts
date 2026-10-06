// Adapted from voltr-integration-scripts apps/cli/src/lib/parse.test.ts (19072d0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./errors.js";
import {
  parseAddress,
  parseAmount,
  parseBps,
  parseCount,
  parseIndex,
  parseU16,
} from "./parse.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("parseAmount accepts raw non-negative integers as bigint", () => {
  assert.equal(parseAmount("0", "--amount"), 0n);
  assert.equal(parseAmount("1000000", "--amount"), 1_000_000n);
  // Beyond Number.MAX_SAFE_INTEGER: must not lose precision.
  assert.equal(
    parseAmount("18446744073709551615", "--amount"),
    18446744073709551615n,
  );
});

test("parseAmount rejects non-integers, decimals, and negatives with the flag name", () => {
  for (const bad of ["abc", "1.5", "-1", "", " 5 ", "0x10", "1e3"]) {
    assert.throws(
      () => parseAmount(bad, "--amount"),
      (error: unknown) =>
        error instanceof CliError && /--amount must be/.test(error.message),
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("parseAddress accepts a valid base58 address", () => {
  assert.equal(parseAddress(USDC, "--destination"), USDC);
});

test("parseAddress rejects a malformed address naming the flag", () => {
  assert.throws(
    () => parseAddress("not-an-address", "--destination"),
    (error: unknown) =>
      error instanceof CliError &&
      /--destination must be a valid base58 Solana address/.test(error.message),
  );
});

test("parseBps accepts 0..10000 and rejects out-of-range / non-integers", () => {
  assert.equal(parseBps("0", "--slippage-bps"), 0);
  assert.equal(parseBps("50", "--slippage-bps"), 50);
  assert.equal(parseBps("10000", "--slippage-bps"), 10_000);
  for (const bad of ["10001", "-1", "1.5", "abc", ""]) {
    assert.throws(
      () => parseBps(bad, "--slippage-bps"),
      (error: unknown) =>
        error instanceof CliError &&
        /--slippage-bps must be an integer between 0 and 10000/.test(
          error.message,
        ),
    );
  }
});

test("parseU16 accepts 0..65535 and rejects above the range", () => {
  assert.equal(parseU16("0", "--value"), 0);
  assert.equal(parseU16("65535", "--value"), 65_535);
  assert.throws(
    () => parseU16("65536", "--value"),
    (error: unknown) => error instanceof CliError && /u16/.test(error.message),
  );
});

test("parseCount requires a positive integer", () => {
  assert.equal(parseCount("1", "--jupiter-max-accounts"), 1);
  assert.equal(parseCount("16", "--jupiter-max-accounts"), 16);
  for (const bad of ["0", "-1", "abc", ""]) {
    assert.throws(
      () => parseCount(bad, "--jupiter-max-accounts"),
      (error: unknown) =>
        error instanceof CliError &&
        /--jupiter-max-accounts must be a positive integer/.test(error.message),
    );
  }
});

test("parseIndex accepts zero and rejects negatives / non-integers", () => {
  assert.equal(parseIndex("0", "--reward-index"), 0);
  assert.equal(parseIndex("3", "--reward-index"), 3);
  for (const bad of ["-1", "1.5", "abc", ""]) {
    assert.throws(
      () => parseIndex(bad, "--reward-index"),
      (error: unknown) =>
        error instanceof CliError &&
        /--reward-index must be a non-negative integer/.test(error.message),
    );
  }
});

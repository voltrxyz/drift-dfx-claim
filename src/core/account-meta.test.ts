// Adapted from voltr-integration-scripts packages/core/src/account-meta.test.ts (19072d0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountRole, address, type Instruction } from "@solana/kit";
import {
  readonlyAccount,
  withRemainingAccounts,
  writableAccount,
} from "./account-meta.js";

const PROGRAM = address("11111111111111111111111111111111");
const A = address("So11111111111111111111111111111111111111112");
const B = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

test("readonlyAccount / writableAccount set the expected role", () => {
  assert.deepEqual(readonlyAccount(A), {
    address: A,
    role: AccountRole.READONLY,
  });
  assert.deepEqual(writableAccount(A), {
    address: A,
    role: AccountRole.WRITABLE,
  });
});

test("withRemainingAccounts appends after existing accounts in order", () => {
  const base: Instruction = {
    programAddress: PROGRAM,
    accounts: [{ address: A, role: AccountRole.WRITABLE_SIGNER }],
  };

  const out = withRemainingAccounts(base, [
    readonlyAccount(B),
    writableAccount(A),
  ]);

  assert.deepEqual(out.accounts, [
    { address: A, role: AccountRole.WRITABLE_SIGNER },
    { address: B, role: AccountRole.READONLY },
    { address: A, role: AccountRole.WRITABLE },
  ]);
  // The original instruction is not mutated.
  assert.equal(base.accounts?.length, 1);
});

test("withRemainingAccounts handles an instruction with no prior accounts", () => {
  const base: Instruction = { programAddress: PROGRAM };
  const out = withRemainingAccounts(base, [readonlyAccount(B)]);
  assert.deepEqual(out.accounts, [{ address: B, role: AccountRole.READONLY }]);
});

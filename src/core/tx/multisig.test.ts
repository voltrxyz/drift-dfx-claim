// Adapted from voltr-integration-scripts packages/core/src/tx/multisig.test.ts (19072d0).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  address,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { buildMultisigPayload } from "./multisig.js";

const MULTISIG_ADDRESS = address("BPFLoaderUpgradeab1e11111111111111111111111");
const LOOKUP_TABLE_ADDRESS = address(
  "AddressLookupTab1e1111111111111111111111111",
);
const WRITABLE_ACCOUNT = address("11111111111111111111111111111111");
const PROGRAM_ADDRESS = address("11111111111111111111111111111112");
const BLOCKHASH = {
  blockhash: "11111111111111111111111111111111" as Blockhash,
  lastValidBlockHeight: 123n,
};

function makeInstruction(dataLength = 4): Instruction {
  return {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      {
        address: WRITABLE_ACCOUNT,
        role: AccountRole.WRITABLE,
      },
    ],
    data: new Uint8Array(dataLength),
  };
}

test("buildMultisigPayload emits a complete legacy transaction", () => {
  const result = buildMultisigPayload({
    blockhash: BLOCKHASH,
    instructions: [makeInstruction()],
    multisigAddress: MULTISIG_ADDRESS,
  });

  const transactionBytes = getBase58Encoder().encode(result.base58Transaction);
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );

  assert.equal(result.transactionVersion, "legacy");
  assert.equal(result.transactionSizeBytes, transactionBytes.length);
  assert.equal(transaction.signatures[MULTISIG_ADDRESS], null);
  assert.equal(message.version, "legacy");
  assert.equal(message.instructions.length, 1);
});

test("buildMultisigPayload emits a complete v0 transaction when using a lookup table", () => {
  const result = buildMultisigPayload({
    addressesByLookupTable: {
      [LOOKUP_TABLE_ADDRESS]: [WRITABLE_ACCOUNT],
    },
    blockhash: BLOCKHASH,
    instructions: [makeInstruction()],
    multisigAddress: MULTISIG_ADDRESS,
  });

  const transactionBytes = getBase58Encoder().encode(result.base58Transaction);
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );

  assert.equal(result.transactionVersion, 0);
  assert.equal(transaction.signatures[MULTISIG_ADDRESS], null);
  assert.equal(message.version, 0);
  assert.equal(message.instructions.length, 1);
});

test("buildMultisigPayload rejects transactions over Solana's size limit", () => {
  assert.throws(
    () =>
      buildMultisigPayload({
        blockhash: BLOCKHASH,
        instructions: [makeInstruction(1_200)],
        multisigAddress: MULTISIG_ADDRESS,
      }),
    /Multisig transaction is \d+ bytes; the Solana limit is \d+/,
  );
});

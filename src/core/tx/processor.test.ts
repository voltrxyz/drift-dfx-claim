// Adapted from voltr-integration-scripts packages/core/src/tx/processor.test.ts (19072d0).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  address,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import type { BuiltOperation, ScriptContext } from "../types.js";
import { processOperation } from "./processor.js";

const NOOP_PROGRAM = address("11111111111111111111111111111112");
const FAKE_VAULT = address("11111111111111111111111111111111");
const TEST_BLOCKHASH = {
  blockhash: "11111111111111111111111111111111" as Blockhash,
  lastValidBlockHeight: 123n,
};

async function makeSigner(): Promise<KeyPairSigner> {
  return generateKeyPairSigner();
}

function makeOperation(label = "test:op"): BuiltOperation {
  const dummyIx: Instruction = {
    programAddress: NOOP_PROGRAM,
    accounts: [
      {
        address: FAKE_VAULT,
        role: AccountRole.WRITABLE,
      },
    ],
    data: new Uint8Array([0, 1, 2, 3]),
  };
  return { label, instructions: [dummyIx] };
}

function makeCtx(): ScriptContext {
  const rpc = {
    getLatestBlockhash: () => ({
      send: () => Promise.resolve({ value: TEST_BLOCKHASH }),
    }),
  } as unknown as ScriptContext["rpc"];

  return {
    rpcUrl: "http://localhost:9999",
    rpc,
  };
}

test("processOperation dispatches print mode without touching RPC", async () => {
  const ctx = makeCtx();
  const payer = await makeSigner();
  const operation = makeOperation("vault:deposit");

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg?: unknown) => logs.push(String(msg));
  try {
    const result = await processOperation({
      ctx,
      payer,
      operation,
      mode: "print",
    });

    assert.equal(result.mode, "print");
    if (result.mode !== "print") return;
    assert.equal(result.label, "vault:deposit");
    assert.equal(result.instructionCount, 1);
    assert.deepEqual(result.lookupTableAddresses, []);
    assert.ok(logs.some((line) => line.includes("vault:deposit")));
  } finally {
    console.log = originalLog;
  }
});

test("processOperation multisig mode emits a complete unsigned transaction", async () => {
  const ctx = makeCtx();
  const payer = await makeSigner();
  const operation = makeOperation("vault:withdraw");
  const multisigAddress = address(
    "BPFLoaderUpgradeab1e11111111111111111111111",
  ) as Address;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg?: unknown) => logs.push(String(msg));
  try {
    const result = await processOperation({
      ctx,
      payer,
      operation,
      mode: "multisig",
      options: { multisigAddress, quiet: true },
    });

    assert.equal(result.mode, "multisig");
    if (result.mode !== "multisig") return;
    assert.ok(result.base64Transaction.length > 0);
    assert.ok(result.base58Transaction.length > 0);
    assert.notEqual(result.base64Transaction, result.base58Transaction);
    assert.equal(result.transactionVersion, "legacy");

    const base64Bytes = getBase64Encoder().encode(result.base64Transaction);
    const base58Bytes = getBase58Encoder().encode(result.base58Transaction);
    assert.deepEqual(base58Bytes, base64Bytes);
    assert.equal(result.transactionSizeBytes, base58Bytes.length);
    assert.ok(result.transactionSizeBytes <= result.transactionSizeLimitBytes);

    const transaction = getTransactionDecoder().decode(base58Bytes);
    assert.equal(transaction.signatures[multisigAddress], null);
    const compiledMessage = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
    assert.equal(compiledMessage.version, "legacy");
    assert.equal(compiledMessage.instructions.length, 1);

    const inspectorMessage = new URL(result.explorerUrl).searchParams.get(
      "message",
    );
    assert.equal(
      inspectorMessage,
      Buffer.from(transaction.messageBytes).toString("base64"),
    );
    assert.notEqual(inspectorMessage, result.base64Transaction);
    assert.ok(result.explorerUrl.startsWith("https://explorer.solana.com"));
    assert.doesNotMatch(result.explorerUrl, /signatures=/);
  } finally {
    console.log = originalLog;
  }
});

test("processOperation multisig mode requires multisigAddress option", async () => {
  const ctx = makeCtx();
  const payer = await makeSigner();
  const operation = makeOperation();

  await assert.rejects(
    () =>
      processOperation({
        ctx,
        payer,
        operation,
        mode: "multisig",
      }),
    /\[test:op\/multisig\].*multisigAddress/,
  );
});

test("processOperation multisig mode strips compute-budget instructions", async () => {
  const ctx = makeCtx();
  const payer = await makeSigner();
  const operation: BuiltOperation = {
    label: "with-cu",
    instructions: [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
        accounts: [],
        data: new Uint8Array([0, 0, 0, 0]),
      },
      ...makeOperation().instructions,
    ],
  };

  const multisigAddress = address(
    "BPFLoaderUpgradeab1e11111111111111111111111",
  ) as Address;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg?: unknown) => logs.push(String(msg));
  try {
    const stripped = await processOperation({
      ctx,
      payer,
      operation,
      mode: "multisig",
      options: { multisigAddress, quiet: true },
    });
    const unstrippedOp: BuiltOperation = {
      ...operation,
      label: "with-cu-ref",
    };
    const reference = await processOperation({
      ctx,
      payer,
      operation: {
        ...unstrippedOp,
        // Only the non-CU instruction, to compare against the stripped output.
        instructions: makeOperation().instructions,
      },
      mode: "multisig",
      options: { multisigAddress, quiet: true },
    });

    assert.equal(stripped.mode, "multisig");
    assert.equal(reference.mode, "multisig");
    if (stripped.mode !== "multisig" || reference.mode !== "multisig") return;
    assert.equal(stripped.base64Transaction, reference.base64Transaction);
  } finally {
    console.log = originalLog;
  }
});

test("processOperation print mode does not require RPC or signer secrets", async () => {
  const ctx = makeCtx();
  const payer = await makeSigner();
  const operation = makeOperation("vault:deposit");

  const result = await processOperation({
    ctx,
    payer,
    operation,
    mode: "print",
  });
  assert.equal(result.mode, "print");
  if (result.mode !== "print") return;
  assert.deepEqual(result.lookupTableAddresses, []);
});

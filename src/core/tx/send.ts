// Adapted from voltr-integration-scripts packages/core/src/tx/send.ts (19072d0).
import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type AddressesByLookupTableAddress,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import type { PriorityFeeStrategy, SolanaRpc } from "../types.js";
import { resolvePriorityFeeMicroLamports } from "./priority-fee.js";

const FEE_PAYER_FOR_SIMULATION = "11111111111111111111111111111112" as Address;

/**
 * Builds a v0 transaction message with the supplied instructions, fee payer,
 * blockhash, and (optional) lookup tables. Used by execute and simulate flows.
 */
export function buildV0Message(args: {
  instructions: Instruction[];
  blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  addressesByLookupTable: AddressesByLookupTableAddress;
  payerSigner?: TransactionSigner;
  payerAddress?: Address;
}) {
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) =>
      args.payerSigner
        ? setTransactionMessageFeePayerSigner(args.payerSigner, m)
        : setTransactionMessageFeePayer(
            args.payerAddress ?? FEE_PAYER_FOR_SIMULATION,
            m,
          ),
    (m) => setTransactionMessageLifetimeUsingBlockhash(args.blockhash, m),
    (m) => appendTransactionMessageInstructions(args.instructions, m),
  );

  if (Object.keys(args.addressesByLookupTable).length > 0) {
    message = compressTransactionMessageUsingAddressLookupTables(
      message,
      args.addressesByLookupTable,
    ) as typeof message;
  }

  return message;
}

export interface SendAndConfirmArgs {
  instructions: Instruction[];
  rpcUrl: string;
  payerSigner: KeyPairSigner;
  addressesByLookupTable?: AddressesByLookupTableAddress;
  computeUnitLimit?: number | null;
  priorityFee?: PriorityFeeStrategy;
}

export interface SendAndConfirmResult {
  signature: Signature;
  computeUnitsConsumed: number | null;
}

export async function sendAndConfirmOptimizedTx(
  args: SendAndConfirmArgs,
): Promise<SendAndConfirmResult> {
  const rpc = createSolanaRpc(args.rpcUrl);
  const addressesByLookupTable = args.addressesByLookupTable ?? {};
  const priorityFee: PriorityFeeStrategy = args.priorityFee ?? {
    kind: "helius",
    priorityLevel: "High",
  };

  const estimateMessageBuilder = (blockhash: {
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
  }) =>
    buildV0Message({
      instructions: args.instructions,
      blockhash,
      addressesByLookupTable,
      payerSigner: args.payerSigner,
    });

  const { unitsConsumed, simErr, simLogs } = await simulateForComputeUnits(
    rpc,
    estimateMessageBuilder,
  );

  if (simErr) {
    throw makeTransactionError({
      stage: "preflight-simulation",
      err: simErr,
      logs: simLogs,
    });
  }

  const optimalCUs =
    args.computeUnitLimit ?? Math.ceil(Number(unitsConsumed ?? 200_000) * 1.1);
  const cuLimitIx = getSetComputeUnitLimitInstruction({ units: optimalCUs });

  // First build to ask for a priority-fee quote — sign a placeholder tx.
  const { value: feeBlockhash } = await rpc.getLatestBlockhash().send();
  const feeEstMessage = buildV0Message({
    instructions: [cuLimitIx, ...args.instructions],
    blockhash: feeBlockhash,
    addressesByLookupTable,
    payerSigner: args.payerSigner,
  });
  const feeEstSigned = await signTransactionMessageWithSigners(feeEstMessage);
  const wireFeeEst = getBase64EncodedWireTransaction(feeEstSigned);

  const microLamports = await resolvePriorityFeeMicroLamports({
    strategy: priorityFee,
    rpcUrl: args.rpcUrl,
    rpc,
    wireTransaction: wireFeeEst,
    writableAccounts: collectWritableAddresses(args.instructions),
  });

  const extraIxs: Instruction[] = [cuLimitIx];
  if (microLamports !== null) {
    extraIxs.push(getSetComputeUnitPriceInstruction({ microLamports }));
  }

  const { value: sendBlockhash } = await rpc.getLatestBlockhash().send();
  const finalMessage = buildV0Message({
    instructions: [...extraIxs, ...args.instructions],
    blockhash: sendBlockhash,
    addressesByLookupTable,
    payerSigner: args.payerSigner,
  });
  const signed = await signTransactionMessageWithSigners(finalMessage);
  assertIsTransactionWithinSizeLimit(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = getSignatureFromTransaction(signed);

  await rpc
    .sendTransaction(wire, {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 5n,
    })
    .send();

  await confirmSignature(rpc, signature, sendBlockhash.lastValidBlockHeight);

  return {
    signature,
    computeUnitsConsumed: unitsConsumed != null ? Number(unitsConsumed) : null,
  };
}

async function simulateForComputeUnits(
  rpc: SolanaRpc,
  buildMessage: (blockhash: {
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
  }) => ReturnType<typeof buildV0Message>,
): Promise<{
  unitsConsumed: bigint | null;
  simErr: unknown;
  simLogs: string[];
}> {
  const { value: latest } = await rpc.getLatestBlockhash().send();
  const simMessage = buildMessage(latest);
  const simSigned = await signTransactionMessageWithSigners(simMessage);
  const wireSim = getBase64EncodedWireTransaction(simSigned);

  const sim = await rpc
    .simulateTransaction(wireSim, {
      encoding: "base64",
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();

  return {
    unitsConsumed: sim.value.unitsConsumed ?? null,
    simErr: sim.value.err,
    simLogs: sim.value.logs ?? [],
  };
}

function collectWritableAddresses(instructions: Instruction[]): string[] {
  const writable = new Set<string>();
  for (const ix of instructions) {
    for (const account of ix.accounts ?? []) {
      const role = account.role as number;
      // Roles 1 (WRITABLE) and 3 (WRITABLE_SIGNER) are writable.
      if (role === 1 || role === 3) {
        writable.add(account.address as string);
      }
    }
  }
  return Array.from(writable);
}

async function confirmSignature(
  rpc: SolanaRpc,
  signature: Signature,
  lastValidBlockHeight: bigint,
): Promise<void> {
  while (true) {
    const { value } = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .send();
    const status = value[0];

    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err) {
        const logs = await tryFetchTransactionLogs(rpc, signature);
        throw makeTransactionError({
          stage: "on-chain",
          signature,
          err: status.err,
          logs,
        });
      }
      return;
    }

    const blockHeight = await rpc.getBlockHeight().send();
    if (blockHeight > lastValidBlockHeight) {
      throw makeTransactionError({
        stage: "expired",
        signature,
        err: `Transaction expired: ${signature} was not confirmed before lastValidBlockHeight ${lastValidBlockHeight}`,
        logs: [],
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function tryFetchTransactionLogs(
  rpc: SolanaRpc,
  signature: Signature,
): Promise<string[]> {
  try {
    const tx = await rpc
      .getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
        encoding: "json",
      })
      .send();
    return tx?.meta?.logMessages ? [...tx.meta.logMessages] : [];
  } catch {
    return [];
  }
}

export interface TransactionFailure extends Error {
  stage: "preflight-simulation" | "on-chain" | "expired";
  signature?: Signature;
  logs: string[];
  cause: unknown;
}

function makeTransactionError(args: {
  stage: TransactionFailure["stage"];
  err: unknown;
  signature?: Signature;
  logs: string[];
}): TransactionFailure {
  const detail =
    typeof args.err === "string"
      ? args.err
      : JSON.stringify(args.err, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        );
  const sigPart = args.signature ? ` [${args.signature}]` : "";
  const error = new Error(
    `Transaction ${args.stage} failure${sigPart}: ${detail}`,
  ) as TransactionFailure;
  error.stage = args.stage;
  error.signature = args.signature;
  error.logs = args.logs;
  error.cause = args.err;
  return error;
}

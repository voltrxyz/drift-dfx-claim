// Adapted from voltr-integration-scripts packages/core/src/tx/simulate.ts (19072d0).
import {
  getBase64EncodedWireTransaction,
  assertIsTransactionWithinSizeLimit,
  getCompiledTransactionMessageEncoder,
  compileTransactionMessage,
  signTransactionMessageWithSigners,
  type AddressesByLookupTableAddress,
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import type {
  PriorityFeeStrategy,
  SimulationLogs,
  SolanaRpc,
} from "../types.js";
import { buildV0Message } from "./send.js";
import { resolvePriorityFeeMicroLamports } from "./priority-fee.js";

/**
 * `lastValidBlockHeight` of 0 — compiles the message without requiring a real
 * blockhash. The RPC replaces it during simulation via `replaceRecentBlockhash`.
 */
const PLACEHOLDER_BLOCKHASH: {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
} = {
  blockhash: "11111111111111111111111111111111" as Blockhash,
  lastValidBlockHeight: 0n,
};

export interface SimulateTxArgs {
  rpc: SolanaRpc;
  instructions: Instruction[];
  addressesByLookupTable?: AddressesByLookupTableAddress;
  payerSigner: TransactionSigner;
  computeUnitLimit?: number;
  priorityFee?: PriorityFeeStrategy;
  rpcUrl?: string;
}

export interface SimulateTxResult {
  simulation: SimulationLogs;
  explorerUrl: string;
}

/**
 * Compiles the supplied instructions, runs `simulateTransaction` against the
 * given RPC, and returns logs + a Solana Explorer inspector link suitable for
 * sharing during code review.
 */
export async function simulateTx(
  args: SimulateTxArgs,
): Promise<SimulateTxResult> {
  const addressesByLookupTable = args.addressesByLookupTable ?? {};

  const instructions =
    args.computeUnitLimit === undefined
      ? [...args.instructions]
      : [
          getSetComputeUnitLimitInstruction({ units: args.computeUnitLimit }),
          ...args.instructions,
        ];
  const preliminary = buildV0Message({
    instructions,
    blockhash: PLACEHOLDER_BLOCKHASH,
    addressesByLookupTable,
    payerSigner: args.payerSigner,
  });
  if (args.priorityFee) {
    const wireTransaction = getBase64EncodedWireTransaction(
      await signTransactionMessageWithSigners(preliminary),
    );
    const microLamports = await resolvePriorityFeeMicroLamports({
      strategy: args.priorityFee,
      rpc: args.rpc,
      rpcUrl: args.rpcUrl ?? "",
      wireTransaction,
      writableAccounts: [
        ...new Set(
          instructions.flatMap((instruction) =>
            (instruction.accounts ?? [])
              .filter((account) => (account.role & 1) !== 0)
              .map((account) => account.address),
          ),
        ),
      ],
    });
    if (microLamports !== null)
      instructions.unshift(
        getSetComputeUnitPriceInstruction({ microLamports }),
      );
  }
  const message = buildV0Message({
    instructions,
    blockhash: PLACEHOLDER_BLOCKHASH,
    addressesByLookupTable,
    payerSigner: args.payerSigner,
  });

  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithinSizeLimit(signed);
  const wire = getBase64EncodedWireTransaction(signed);

  const sim = await args.rpc
    .simulateTransaction(wire, {
      encoding: "base64",
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();

  const explorerUrl = buildInspectorUrl(
    message,
    args.payerSigner.address as Address,
  );

  return {
    simulation: {
      unitsConsumed:
        sim.value.unitsConsumed != null
          ? Number(sim.value.unitsConsumed)
          : null,
      logs: sim.value.logs ?? [],
      err: sim.value.err,
    },
    explorerUrl,
  };
}

function buildInspectorUrl(
  // The Kit message type is generic; the encoder accepts the compiled form.
  message: Parameters<typeof compileTransactionMessage>[0],
  feePayer: Address,
): string {
  const compiled = compileTransactionMessage(message);
  const bytes = getCompiledTransactionMessageEncoder().encode(compiled);
  const base64 = Buffer.from(bytes).toString("base64");
  const encodedMessage = encodeURIComponent(base64);
  const signatures = encodeURIComponent(JSON.stringify([feePayer]));
  return `https://explorer.solana.com/tx/inspector?message=${encodedMessage}&signatures=${signatures}`;
}

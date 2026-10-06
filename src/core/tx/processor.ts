// Adapted from voltr-integration-scripts packages/core/src/tx/processor.ts (19072d0).
import type { KeyPairSigner } from "@solana/kit";
import type {
  BuiltOperation,
  ProcessorOptions,
  ProcessResult,
  ScriptContext,
  TxMode,
} from "../types.js";
import { getAddressesByLookupTable } from "./lut.js";
import { buildMultisigPayload } from "./multisig.js";
import { sendAndConfirmOptimizedTx, type TransactionFailure } from "./send.js";
import { simulateTx } from "./simulate.js";

export interface ProcessOperationArgs {
  ctx: ScriptContext;
  payer?: KeyPairSigner;
  operation: BuiltOperation;
  mode: TxMode;
  options?: ProcessorOptions;
}

export async function processOperation(
  args: ProcessOperationArgs,
): Promise<ProcessResult> {
  const { ctx, mode, operation, payer } = args;
  const options = args.options ?? {};

  try {
    switch (mode) {
      case "print":
        return runPrintMode(operation);
      case "simulate":
        if (!payer)
          throw new Error("simulate mode requires a manager keypair.");
        return await runSimulateMode(ctx, payer, operation, options);
      case "multisig":
        return await runMultisigMode(ctx, operation, options);
      case "execute":
        if (!payer) throw new Error("execute mode requires a manager keypair.");
        return await runExecuteMode(ctx, payer, operation, options);
    }
  } catch (error) {
    throw decorateError(error, operation.label, mode);
  }
}

function runPrintMode(operation: BuiltOperation): ProcessResult {
  const lookupTableAddresses = operation.lookupTableAddresses ?? [];
  const summary = {
    label: operation.label,
    instructionCount: operation.instructions.length,
    lookupTableAddresses,
  };
  console.log(JSON.stringify(summary, null, 2));
  logOperationMetadata(operation);
  return { mode: "print", ...summary };
}

/**
 * Keep operator output in the processor so builders remain free of console I/O.
 */
function logOperationMetadata(operation: BuiltOperation): void {
  if (!operation.metadata) return;
  const entries = Object.entries(operation.metadata);
  if (entries.length === 0) return;
  console.log(`${operation.label} metadata:`);
  for (const [key, value] of entries) {
    console.log(`  ${key}: ${value}`);
  }
}

async function runSimulateMode(
  ctx: ScriptContext,
  payer: KeyPairSigner,
  operation: BuiltOperation,
  options: ProcessorOptions,
): Promise<ProcessResult> {
  const addressesByLookupTable = operation.lookupTableAddresses?.length
    ? await getAddressesByLookupTable(operation.lookupTableAddresses, ctx.rpc)
    : {};

  const { simulation, explorerUrl } = await simulateTx({
    rpc: ctx.rpc,
    instructions: operation.instructions,
    addressesByLookupTable,
    payerSigner: payer,
    computeUnitLimit:
      options.computeUnitLimit ?? operation.computeUnitLimit ?? undefined,
    priorityFee: options.priorityFee,
    rpcUrl: ctx.rpcUrl,
  });

  console.log(
    `${operation.label} simulation: ${simulation.err ? "FAILED" : "OK"}`,
  );
  logOperationMetadata(operation);
  if (simulation.unitsConsumed != null) {
    console.log(`  computeUnits: ${simulation.unitsConsumed}`);
  }
  if (simulation.logs.length > 0) {
    console.log("  logs:");
    for (const line of simulation.logs) console.log(`    ${line}`);
  }
  if (simulation.err) {
    console.log(
      `  error: ${JSON.stringify(simulation.err, (_, value) => (typeof value === "bigint" ? value.toString() : value))}`,
    );
  }
  if (!options.quiet) {
    console.log(`  explorer: ${explorerUrl}`);
  }

  return { mode: "simulate", simulation, explorerUrl };
}

async function runMultisigMode(
  ctx: ScriptContext,
  operation: BuiltOperation,
  options: ProcessorOptions,
): Promise<ProcessResult> {
  if (!options.multisigAddress) {
    throw new Error(
      "multisig mode requires options.multisigAddress (the vault PDA that will sign onchain).",
    );
  }

  const { value: blockhash } = await ctx.rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const result = buildMultisigPayload({
    blockhash,
    instructions: operation.instructions,
    multisigAddress: options.multisigAddress,
    stripComputeBudget: true,
    addressesByLookupTable: operation.lookupTableAddresses?.length
      ? await getAddressesByLookupTable(operation.lookupTableAddresses, ctx.rpc)
      : {},
  });

  console.log(`${operation.label} multisig payload:`);
  logOperationMetadata(operation);
  console.log(`  format: ${result.transactionVersion}`);
  console.log(
    `  bytes: ${result.transactionSizeBytes}/${result.transactionSizeLimitBytes}`,
  );
  console.log(`  base64: ${result.base64Transaction}`);
  console.log(`  base58: ${result.base58Transaction}`);
  if (!options.quiet) {
    console.log(`  explorer: ${result.explorerUrl}`);
  }

  return { mode: "multisig", ...result };
}

async function runExecuteMode(
  ctx: ScriptContext,
  payer: KeyPairSigner,
  operation: BuiltOperation,
  options: ProcessorOptions,
): Promise<ProcessResult> {
  const addressesByLookupTable = operation.lookupTableAddresses?.length
    ? await getAddressesByLookupTable(operation.lookupTableAddresses, ctx.rpc)
    : {};

  // Show the operator what is about to move (e.g. the claim recipient) before sending.
  logOperationMetadata(operation);
  const { signature, computeUnitsConsumed } = await sendAndConfirmOptimizedTx({
    instructions: operation.instructions,
    rpcUrl: ctx.rpcUrl,
    payerSigner: payer,
    addressesByLookupTable,
    computeUnitLimit:
      options.computeUnitLimit ?? operation.computeUnitLimit ?? null,
    priorityFee: options.priorityFee,
  });

  console.log(`${operation.label} signature: ${signature}`);
  return { mode: "execute", signature, computeUnitsConsumed };
}

function decorateError(error: unknown, label: string, mode: TxMode): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  const decorated = new Error(`[${label}/${mode}] ${base.message}`);
  (decorated as Error & { cause?: unknown }).cause = base;
  const failure = base as Partial<TransactionFailure>;
  if (failure.logs && failure.logs.length > 0) {
    console.error(`[${label}/${mode}] transaction logs:`);
    for (const line of failure.logs) console.error(`  ${line}`);
  }
  return decorated;
}

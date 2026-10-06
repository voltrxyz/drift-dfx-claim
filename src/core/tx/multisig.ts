// Adapted from voltr-integration-scripts packages/core/src/tx/multisig.ts (19072d0).
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  TRANSACTION_SIZE_LIMIT,
  type AddressesByLookupTableAddress,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";

export interface MultisigTxArgs {
  instructions: Instruction[];
  addressesByLookupTable?: AddressesByLookupTableAddress;
  /** Recent blockhash used to make the import payload a valid transaction. */
  blockhash: {
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
  };
  /** Multisig vault PDA that will pay/sign onchain. */
  multisigAddress: Address;
  /**
   * If true, strip any compute-budget instructions before serializing. Squads
   * and other multisig frontends typically inject these themselves.
   */
  stripComputeBudget?: boolean;
}

export interface MultisigTxResult {
  base64Transaction: string;
  base58Transaction: string;
  explorerUrl: string;
  transactionSizeBytes: number;
  transactionSizeLimitBytes: number;
  transactionVersion: "legacy" | 0;
}

/**
 * Produces a complete unsigned transaction for a multisig frontend. Missing
 * signatures are encoded as zero-filled slots so Squads can deserialize the
 * Base58 transaction and extract its instructions. The Explorer inspector still
 * receives the transaction's message bytes, which is the format it expects.
 */
export function buildMultisigPayload(args: MultisigTxArgs): MultisigTxResult {
  const instructions = args.stripComputeBudget
    ? args.instructions.filter(
        (instruction) =>
          instruction.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS,
      )
    : args.instructions;

  const payer = createNoopSigner(args.multisigAddress);
  const addressesByLookupTable = args.addressesByLookupTable ?? {};
  const usesLookupTables = Object.keys(addressesByLookupTable).length > 0;

  const transaction = (() => {
    if (usesLookupTables) {
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (currentMessage) =>
          setTransactionMessageFeePayerSigner(payer, currentMessage),
        (currentMessage) =>
          setTransactionMessageLifetimeUsingBlockhash(
            args.blockhash,
            currentMessage,
          ),
        (currentMessage) =>
          appendTransactionMessageInstructions(instructions, currentMessage),
        (currentMessage) =>
          compressTransactionMessageUsingAddressLookupTables(
            currentMessage,
            addressesByLookupTable,
          ),
      );
      return compileTransaction(message);
    }

    const message = pipe(
      createTransactionMessage({ version: "legacy" }),
      (currentMessage) =>
        setTransactionMessageFeePayerSigner(payer, currentMessage),
      (currentMessage) =>
        setTransactionMessageLifetimeUsingBlockhash(
          args.blockhash,
          currentMessage,
        ),
      (currentMessage) =>
        appendTransactionMessageInstructions(instructions, currentMessage),
    );
    return compileTransaction(message);
  })();

  const transactionBytes = getTransactionEncoder().encode(transaction);
  const transactionSizeBytes = transactionBytes.length;
  // This builder emits legacy or v0 transactions, which share this fixed limit.
  const transactionSizeLimitBytes = TRANSACTION_SIZE_LIMIT;
  if (transactionSizeBytes > transactionSizeLimitBytes) {
    throw new Error(
      `Multisig transaction is ${transactionSizeBytes} bytes; the Solana limit is ${transactionSizeLimitBytes}. Split the operation into smaller transactions or use a lookup table.`,
    );
  }

  const base64Transaction = Buffer.from(transactionBytes).toString("base64");
  const base58Transaction = getBase58Decoder().decode(transactionBytes);
  const base64Message = Buffer.from(transaction.messageBytes).toString(
    "base64",
  );
  const explorerUrl = `https://explorer.solana.com/tx/inspector?message=${encodeURIComponent(
    base64Message,
  )}`;

  return {
    base64Transaction,
    base58Transaction,
    explorerUrl,
    transactionSizeBytes,
    transactionSizeLimitBytes,
    transactionVersion: usesLookupTables ? 0 : "legacy",
  };
}

// Adapted from voltr-integration-scripts packages/core/src/tx/lut.ts (19072d0).
import {
  fetchAddressLookupTable,
  getExtendLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import {
  type Address,
  type AddressesByLookupTableAddress,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { SolanaRpc } from "../types.js";

export async function getAddressesByLookupTable(
  keys: Address[],
  rpc: SolanaRpc,
): Promise<AddressesByLookupTableAddress> {
  const result: AddressesByLookupTableAddress = {};

  for (const key of keys) {
    const lut = await fetchAddressLookupTable(rpc, key);
    result[key] = [...lut.data.addresses];
  }

  return result;
}

export function collectInstructionAddresses(
  instructions: Instruction[],
): Address[] {
  return Array.from(
    new Set(
      instructions.flatMap((ix) =>
        (ix.accounts ?? []).map((account) => account.address as Address),
      ),
    ),
  );
}

export async function buildExtendLookupTableInstructions(args: {
  rpc: SolanaRpc;
  payer: TransactionSigner;
  authority: TransactionSigner;
  lookupTable: Address;
  addresses: Address[];
}): Promise<Instruction[]> {
  const lutAccount = await fetchAddressLookupTable(args.rpc, args.lookupTable);
  const existing = new Set<string>(lutAccount.data.addresses);
  const missing = args.addresses.filter((address) => !existing.has(address));

  if (missing.length === 0) {
    return [];
  }

  return [
    getExtendLookupTableInstruction({
      address: args.lookupTable,
      authority: args.authority,
      payer: args.payer,
      addresses: missing,
    }),
  ];
}

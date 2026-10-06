import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
  getAddressLookupTableEncoder,
} from "@solana-program/address-lookup-table";
import { processOperation } from "./processor.js";
import { buildDfxClaimOperation } from "../../dfx/operations.js";
import {
  BLOCKHASH,
  createClaimFixture,
  encodedAccount,
} from "../../../test/fixtures.js";

test("processor includes the supplied LUT in a DFX multisig payload", async (context) => {
  const { ctx, args, accounts } = await createClaimFixture({
    blockhash: BLOCKHASH,
  });
  const lookupTable = address("11111111111111111111111111111113");
  const operation = await buildDfxClaimOperation(ctx, {
    ...args,
    lookupTableAddresses: [lookupTable],
  });
  assert.deepEqual(operation.lookupTableAddresses, [lookupTable]);
  const addresses = [
    ...new Set(
      operation.instructions.flatMap((instruction) =>
        (instruction.accounts ?? [])
          .filter((account) => (account.role & 2) === 0)
          .map((account) => account.address),
      ),
    ),
  ];
  accounts.set(
    lookupTable,
    encodedAccount(
      ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
      getAddressLookupTableEncoder().encode({
        addresses,
        authority: args.manager.address,
        deactivationSlot: (1n << 64n) - 1n,
        lastExtendedSlot: 1n,
        lastExtendedSlotStartIndex: 0,
      }),
    ),
  );
  context.mock.method(console, "log", () => {});
  const result = await processOperation({
    ctx,
    operation,
    mode: "multisig",
    options: { multisigAddress: args.manager.address, quiet: true },
  });
  assert.equal(result.mode, "multisig");
  assert.equal(result.transactionVersion, 0);
  assert.ok(result.transactionSizeBytes < 1161);
  const transaction = getTransactionDecoder().decode(
    Buffer.from(result.base64Transaction, "base64"),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  assert.equal(message.version, 0);
  assert.equal(
    message.addressTableLookups![0]!.lookupTableAddress,
    lookupTable,
  );
  context.diagnostic(
    `Synthetic full-account LUT multisig import: ${result.transactionSizeBytes} bytes (does not include Squads wrapping).`,
  );
});

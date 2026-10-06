import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isOffCurveAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  AccountState,
  getTokenDecoder,
  getTokenEncoder,
} from "@solana-program/token";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  getVaultDecoder,
  getVaultEncoder,
  getStrategyInitReceiptDecoder,
  getStrategyInitReceiptEncoder,
} from "@voltr/vault-sdk";
import {
  buildDfxClaimOperation,
  buildDfxSetupOperation,
  type DfxClaimArgs,
} from "./operations.js";
import { assertBuiltOperationShape } from "../core/testing.js";
import { buildMultisigPayload } from "../core/tx/multisig.js";
import { buildV0Message } from "../core/tx/send.js";
import { deriveClaimStatus, deriveDfxAta } from "./pda.js";
import {
  accountBytes,
  BLOCKHASH,
  claimStatusAccount,
  createClaimFixture,
  encodedAccount,
  golden,
  managerAddress,
  snapshot,
  tokenAccount,
  vaultAddress,
} from "../../test/fixtures.js";

test("GOLDEN: claim instruction matches the LiteSVM harness byte for byte", async () => {
  const { ctx, args, manager } = await createClaimFixture();
  assert.equal(manager.address, golden.manager);
  const operation = await buildDfxClaimOperation(ctx, args);
  assertBuiltOperationShape(operation, { label: "dfx:claim" });
  assert.equal(operation.instructions.length, 1);
  const instruction = operation.instructions[0]!;
  assert.equal(instruction.programAddress, golden.instruction.programAddress);
  assert.deepEqual(
    instruction.accounts!.map((account) => ({
      address: account.address,
      role: AccountRole[account.role],
    })),
    golden.instruction.accounts,
  );
  assert.equal(
    Buffer.from(instruction.data!).toString("hex"),
    golden.instruction.dataHex,
  );
  assert.equal(instruction.data!.length, golden.instruction.dataLength);
  assert.deepEqual(operation.metadata, {
    claimant: golden.vaultStrategyAuth,
    distributor: golden.distributor,
    claimStatus: golden.claimStatus,
    allocationDfx: "428519.051459",
    allocationBaseUnits: "428519051459",
    claimantTokenAccount: golden.claimantTokenAccount,
    recipientTokenAccount: golden.recipientTokenAccount,
  });
});

test("a pre-funded, system-owned ClaimStatus PDA does not count as claimed", async () => {
  const { ctx, args, accounts } = await createClaimFixture();
  // Anyone can send lamports to the PDA; the on-chain init still succeeds.
  accounts.set(
    golden.claimStatus,
    encodedAccount(address("11111111111111111111111111111111"), new Uint8Array()),
  );
  const operation = await buildDfxClaimOperation(ctx, args);
  assert.equal(
    Buffer.from(operation.instructions[0]!.data!).toString("hex"),
    golden.instruction.dataHex,
  );
  // A token-program account at that address is not an initialized ClaimStatus either.
  accounts.set(golden.claimStatus, tokenAccount(managerAddress));
  await assert.doesNotReject(buildDfxClaimOperation(ctx, args));
});

test("claim accepts the vault admin and an explicit non-ATA recipient", async () => {
  const { ctx, args, accounts } = await createClaimFixture();
  const original = accounts.get(vaultAddress)!;
  const vault = getVaultDecoder().decode(accountBytes(original));
  accounts.set(
    vaultAddress,
    encodedAccount(
      original.owner,
      getVaultEncoder().encode({
        ...vault,
        manager: vault.admin,
        admin: args.manager.address,
      }),
    ),
  );
  const recipientTokenAccount = address("11111111111111111111111111111112");
  accounts.set(recipientTokenAccount, tokenAccount(managerAddress));
  const operation = await buildDfxClaimOperation(ctx, {
    ...args,
    recipient: undefined,
    recipientTokenAccount,
  });
  assert.equal(
    operation.instructions[0]!.accounts![14]!.address,
    recipientTokenAccount,
  );
});

type Fixture = Awaited<ReturnType<typeof createClaimFixture>>;
const negatives: Array<[string, (fixture: Fixture) => void, RegExp]> = [
  [
    "already claimed",
    ({ accounts }) => {
      accounts.set(golden.claimStatus, claimStatusAccount());
    },
    /already claimed.*8JyV7iohbinE7a7YFRXyrTGQFHmqbMQ28wMuhuyvEy6n/,
  ],
  [
    "signer not manager or admin",
    ({ args }) => {
      args.manager = { ...args.manager, address: address(golden.distributor) };
    },
    /not the vault manager.*or admin/,
  ],
  [
    "tampered amount",
    ({ args }) => {
      args.eligibility[0]!.amountUnlocked += 1n;
    },
    /Merkle proof mismatch/,
  ],
  [
    "tampered proof",
    ({ args }) => {
      args.eligibility[0]!.proof[0] = new Uint8Array(32);
    },
    /Merkle proof mismatch/,
  ],
  [
    "missing claimant ATA",
    ({ accounts }) => {
      accounts.delete(golden.claimantTokenAccount);
    },
    /Claimant DFX token account.*does not exist.*dfx:setup/,
  ],
  [
    "recipient owned by claimant",
    ({ accounts }) => {
      accounts.set(
        golden.recipientTokenAccount,
        tokenAccount(address(golden.vaultStrategyAuth)),
      );
    },
    /Recipient token account owner must differ from vault_strategy_auth/,
  ],
  [
    "different adaptor",
    ({ accounts }) => {
      const key = snapshot.accounts.strategy_init_receipt!.address;
      const original = accounts.get(key)!;
      const receipt = getStrategyInitReceiptDecoder().decode(
        accountBytes(original),
      );
      accounts.set(
        key,
        encodedAccount(
          original.owner,
          getStrategyInitReceiptEncoder().encode({
            ...receipt,
            adaptorProgram: managerAddress,
          }),
        ),
      );
    },
    /StrategyInitReceipt has a different adaptor/,
  ],
  [
    "non-DFX distributor mint",
    ({ accounts }) => {
      const original = accounts.get(golden.distributor)!;
      const data = accountBytes(original);
      // Borsh prefix: discriminator + bump + version + root = 49 bytes.
      data.fill(0, 49, 81);
      accounts.set(golden.distributor, encodedAccount(original.owner, data));
    },
    /Distributor.*mint is not DFX/,
  ],
  [
    "distributor wrong program owner",
    ({ accounts }) => {
      accounts.get(golden.distributor)!.owner = managerAddress;
    },
    /Distributor.*must be owned by program/,
  ],
  [
    "invalid distributor discriminator",
    ({ accounts }) => {
      const original = accounts.get(golden.distributor)!;
      const data = accountBytes(original);
      data[0] ^= 1;
      accounts.set(golden.distributor, encodedAccount(original.owner, data));
    },
    /invalid MerkleDistributor discriminator/,
  ],
  [
    "insufficient distributor balance",
    ({ accounts }) => {
      accounts.set(
        golden.distributorTokenAccount,
        tokenAccount(address(golden.distributor), 1n),
      );
    },
    /Distributor token vault balance 1 is below allocation/,
  ],
  [
    "claimant wrong owner",
    ({ accounts }) => {
      accounts.set(golden.claimantTokenAccount, tokenAccount(managerAddress));
    },
    /Claimant DFX token account owner.*dfx:setup/,
  ],
  [
    "claimant frozen",
    ({ accounts }) => {
      const original = accounts.get(golden.claimantTokenAccount)!;
      accounts.set(
        golden.claimantTokenAccount,
        encodedAccount(
          original.owner,
          getTokenEncoder().encode({
            ...getTokenDecoder().decode(accountBytes(original)),
            state: AccountState.Frozen,
          }),
        ),
      );
    },
    /unfrozen.*dfx:setup/,
  ],
  [
    "missing vault",
    ({ accounts }) => {
      accounts.delete(vaultAddress);
    },
    /Vault.*does not exist/,
  ],
  [
    "missing strategy receipt",
    ({ accounts }) => {
      accounts.delete(snapshot.accounts.strategy_init_receipt!.address);
    },
    /StrategyInitReceipt.*does not exist/,
  ],
  [
    "missing recipient",
    ({ accounts }) => {
      accounts.delete(golden.recipientTokenAccount);
    },
    /Recipient DFX token account.*does not exist/,
  ],
  [
    "nonzero locked amount",
    ({ args }) => {
      args.eligibility[0]!.amountLocked = 1n;
    },
    /locked_amount must be zero/,
  ],
];
for (const [name, mutate, expected] of negatives) {
  test(`claim preflight rejects ${name}`, async () => {
    const fixture = await createClaimFixture();
    mutate(fixture);
    await assert.rejects(
      buildDfxClaimOperation(fixture.ctx, fixture.args),
      expected,
    );
  });
}

test("claim refuses early claims, including before start_ts and one second before end_ts", async () => {
  for (const blockTime of [1785905999n, 1785906000n]) {
    const { ctx, args } = await createClaimFixture({ blockTime });
    await assert.rejects(
      buildDfxClaimOperation(ctx, args),
      /Refusing early claim.*end_ts=.*forfeits/,
    );
  }
  const { ctx, args } = await createClaimFixture({ blockTime: 1785906001n });
  assert.equal(
    (await buildDfxClaimOperation(ctx, args)).instructions.length,
    1,
  );
});

test("claim refuses disabled, clawed back and untimed distributors", async () => {
  for (const change of ["enable", "clawback", "time"] as const) {
    const { ctx, args, accounts } = await createClaimFixture(
      change === "time" ? { blockTime: null } : {},
    );
    const original = accounts.get(golden.distributor)!;
    const data = accountBytes(original);
    // Fixed Borsh prefix through admin: 8+1+8+32+32+32+5*8+3*8+2*32 = 241.
    if (change === "clawback") data[241] = 1;
    if (change === "enable")
      data.writeBigUInt64LE(BigInt(snapshot.slot) + 1n, 242);
    accounts.set(golden.distributor, encodedAccount(original.owner, data));
    await assert.rejects(
      buildDfxClaimOperation(ctx, args),
      change === "time"
        ? /no block time/
        : change === "enable"
          ? /not enabled until slot/
          : /clawed back/,
    );
  }
});

test("claim allocation selection uses onchain ClaimStatus and supports --distributor", async () => {
  const { ctx, args, accounts } = await createClaimFixture();
  const other = { ...args.eligibility[0]!, distributor: managerAddress };
  const multiple: DfxClaimArgs = {
    ...args,
    eligibility: [...args.eligibility, other],
  };
  await assert.rejects(
    buildDfxClaimOperation(ctx, multiple),
    /Multiple unclaimed.*--distributor.*5XKv.*D2m5/,
  );
  const selected = await buildDfxClaimOperation(ctx, {
    ...multiple,
    distributor: address(golden.distributor),
  });
  assert.equal(selected.metadata!.distributor, golden.distributor);
  await assert.rejects(
    buildDfxClaimOperation(ctx, { ...args, distributor: vaultAddress }),
    /No DFX allocation.*distributor/,
  );
  await assert.rejects(
    buildDfxClaimOperation(ctx, { ...args, eligibility: [] }),
    /No DFX allocation.*404/,
  );
  accounts.set(
    await deriveClaimStatus(args.eligibility[0]!.claimant, other.distributor),
    claimStatusAccount(),
  );
  const automaticallySelected = await buildDfxClaimOperation(ctx, multiple);
  assert.equal(automaticallySelected.metadata!.distributor, golden.distributor);
  await assert.rejects(
    buildDfxClaimOperation(ctx, {
      ...multiple,
      distributor: other.distributor,
    }),
    /already claimed/,
  );
  const withOtherMint = await buildDfxClaimOperation(ctx, {
    ...args,
    eligibility: [...args.eligibility, { ...other, mint: vaultAddress }],
  });
  assert.equal(withOtherMint.metadata!.distributor, golden.distributor);
  await assert.rejects(
    buildDfxClaimOperation(ctx, {
      ...args,
      eligibility: [...args.eligibility, ...args.eligibility],
    }),
    /duplicate distributor/,
  );
});

test("size: legacy claim, compute budget, v0 execution and multisig payload", async (context) => {
  const { ctx, args, manager } = await createClaimFixture();
  const operation = await buildDfxClaimOperation(ctx, args);
  const budget = [
    getSetComputeUnitLimitInstruction({ units: 200_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
  ];
  const sizes = [];
  for (const instructions of [
    operation.instructions,
    [...budget, ...operation.instructions],
  ]) {
    const message = pipe(
      createTransactionMessage({ version: "legacy" }),
      (message) => setTransactionMessageFeePayerSigner(manager, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, message),
      (message) => appendTransactionMessageInstructions(instructions, message),
    );
    sizes.push(
      getTransactionEncoder().encode(compileTransaction(message)).length,
    );
  }
  assert.deepEqual(sizes, [1161, 1213]);
  assert.ok(sizes[1]! <= 1232);
  const multisig = buildMultisigPayload({
    instructions: operation.instructions,
    blockhash: BLOCKHASH,
    multisigAddress: manager.address,
  });
  assert.equal(multisig.transactionSizeBytes, sizes[0]);
  assert.equal(
    Buffer.from(multisig.base64Transaction, "base64").length,
    multisig.transactionSizeBytes,
  );
  const v0 = compileTransaction(
    buildV0Message({
      instructions: [...budget, ...operation.instructions],
      blockhash: BLOCKHASH,
      payerSigner: manager,
      addressesByLookupTable: {},
    }),
  );
  assert.equal(getTransactionEncoder().encode(v0).length, 1215);
  context.diagnostic(
    `Claim legacy: ${sizes[0]} bytes; with CU limit + price: ${sizes[1]}; v0 with CU limit + price: 1215; multisig import: ${multisig.transactionSizeBytes}; limit: 1232.`,
  );
});

test("setup rejects a vault or strategy that is not a Voltr Drift strategy", async () => {
  const { ctx, args, accounts } = await createClaimFixture();
  const unknown = address("11111111111111111111111111111112");
  await assert.rejects(
    buildDfxSetupOperation(ctx, { ...args, vault: unknown }),
    /Vault/,
  );
  await assert.rejects(
    buildDfxSetupOperation(ctx, { ...args, strategy: unknown }),
    /StrategyInitReceipt/,
  );
  accounts.delete(vaultAddress);
  await assert.rejects(buildDfxSetupOperation(ctx, args), /Vault/);
});

test("setup uses idempotent ATA creates for off-curve claimant and recipient, and multisig payer", async () => {
  const { ctx, args } = await createClaimFixture();
  const recipient = address(golden.distributor);
  assert.ok(isOffCurveAddress(address(golden.vaultStrategyAuth)));
  assert.ok(isOffCurveAddress(recipient));
  const manager = createNoopSigner(recipient);
  const operation = await buildDfxSetupOperation(ctx, {
    ...args,
    manager,
    recipient,
  });
  assertBuiltOperationShape(operation, { label: "dfx:setup" });
  assert.equal(operation.instructions.length, 2);
  for (const [index, owner] of [
    address(golden.vaultStrategyAuth),
    recipient,
  ].entries()) {
    const instruction = operation.instructions[index]!;
    assert.equal(
      instruction.programAddress,
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    );
    assert.deepEqual([...instruction.data!], [1]);
    assert.equal(instruction.accounts![0]!.address, manager.address);
    assert.equal(instruction.accounts![1]!.address, await deriveDfxAta(owner));
    assert.equal(instruction.accounts![2]!.address, owner);
  }
  const payload = buildMultisigPayload({
    instructions: operation.instructions,
    blockhash: BLOCKHASH,
    multisigAddress: manager.address,
  });
  const transaction = getTransactionDecoder().decode(
    Buffer.from(payload.base64Transaction, "base64"),
  );
  assert.deepEqual(Object.keys(transaction.signatures), [manager.address]);
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  assert.equal(message.version, "legacy");
  assert.equal(message.instructions.length, 2);
  const claimantOnly = await buildDfxSetupOperation(ctx, {
    ...args,
    recipient: undefined,
  });
  assert.equal(claimantOnly.instructions.length, 1);
});

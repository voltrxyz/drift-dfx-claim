import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getAddressEncoder } from "@solana/kit";
import { DFX_DISCRIMINATOR, DFX_MINT, formatDfx } from "./constants.js";
import {
  decodeMerkleDistributor,
  encodeDfxAdditionalArgs,
  verifyDfxProof,
} from "./distributor.js";
import {
  accountBytes,
  createClaimFixture,
  golden,
} from "../../test/fixtures.js";

test("Anchor discriminators match sha256", () => {
  for (const [name, bytes] of [
    ["global:claim_dfx", DFX_DISCRIMINATOR.CLAIM_DFX],
    ["account:MerkleDistributor", DFX_DISCRIMINATOR.MERKLE_DISTRIBUTOR],
    ["account:ClaimStatus", DFX_DISCRIMINATOR.CLAIM_STATUS],
  ] as const) {
    assert.deepEqual(
      [...createHash("sha256").update(name).digest().subarray(0, 8)],
      [...bytes],
    );
  }
});

test("additional_args encodes u64 LE amounts and u32 LE proof length", () => {
  const proof = [
    Uint8Array.from({ length: 32 }, (_, index) => index),
    new Uint8Array(32).fill(17),
  ];
  const encoded = Buffer.from(
    encodeDfxAdditionalArgs({
      amountUnlocked: 0x102030405060708n,
      amountLocked: 0x1122334455667788n,
      proof,
    }),
  );
  assert.equal(
    encoded.subarray(0, 20).toString("hex"),
    "0807060504030201887766554433221102000000",
  );
  assert.equal(encoded.length, 20 + 64);
  assert.deepEqual(encoded.subarray(20), Buffer.concat(proof));
  assert.throws(() =>
    encodeDfxAdditionalArgs({ amountUnlocked: -1n, amountLocked: 0n, proof }),
  );
  assert.throws(() =>
    encodeDfxAdditionalArgs({
      amountUnlocked: 1n << 64n,
      amountLocked: 0n,
      proof,
    }),
  );
  assert.throws(
    () =>
      encodeDfxAdditionalArgs({
        amountUnlocked: 1n,
        amountLocked: 0n,
        proof: [new Uint8Array(31)],
      }),
    /exactly 32 bytes/,
  );
});

test("decode pinned distributor and verify the real proof", async () => {
  const { accounts, args } = await createClaimFixture();
  const distributor = decodeMerkleDistributor(
    accountBytes(accounts.get(golden.distributor)!),
  );
  assert.equal(distributor.mint, DFX_MINT);
  assert.equal(distributor.tokenVault, golden.distributorTokenAccount);
  assert.equal(distributor.startTs, 1785906000n);
  assert.equal(distributor.endTs, 1785906001n);
  assert.equal(distributor.clawedBack, false);
  assert.ok(verifyDfxProof(args.eligibility[0]!, distributor.root));
  assert.equal(
    verifyDfxProof(
      { ...args.eligibility[0]!, amountLocked: 1n },
      distributor.root,
    ),
    false,
  );
  assert.throws(
    () => decodeMerkleDistributor(new Uint8Array(10)),
    /discriminator/,
  );
  assert.throws(
    () =>
      decodeMerkleDistributor(
        new Uint8Array([...DFX_DISCRIMINATOR.MERKLE_DISTRIBUTOR, 0]),
      ),
    /truncated/,
  );
});

test("single-leaf tree and large DFX amounts use exact integer arithmetic", async () => {
  const { args } = await createClaimFixture();
  const entry = {
    ...args.eligibility[0]!,
    proof: [],
    amountUnlocked: (1n << 64n) - 1n,
  };
  const amounts = Buffer.alloc(16);
  amounts.writeBigUInt64LE(entry.amountUnlocked);
  const inner = createHash("sha256")
    .update(Buffer.from(getAddressEncoder().encode(entry.claimant)))
    .update(amounts)
    .digest();
  const root = createHash("sha256")
    .update(new Uint8Array([0]))
    .update(inner)
    .digest();
  assert.ok(verifyDfxProof(entry, root));
  assert.equal(formatDfx(entry.amountUnlocked), "18446744073709.551615");
});

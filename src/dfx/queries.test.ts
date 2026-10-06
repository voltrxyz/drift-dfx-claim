import { test } from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import {
  getStrategyInitReceiptSize,
  VOLTR_VAULT_PROGRAM_ADDRESS,
} from "@voltr/vault-sdk";
import { DRIFT_ADAPTOR_PROGRAM_ID } from "./constants.js";
import { queryDfxStatus } from "./queries.js";
import { loadEligibility } from "../cli/lib/eligibility.js";
import {
  claimStatusAccount,
  createClaimFixture,
  encodedAccount,
  golden,
  snapshot,
  strategyAddress,
  tokenAccount,
  vaultAddress,
} from "../../test/fixtures.js";

test("status discovers only Drift StrategyInitReceipts using size, vault and adaptor filters", async () => {
  let discoveryCalls = 0;
  const fixture = await createClaimFixture({
    getProgramAccounts: (program, config) => {
      discoveryCalls++;
      assert.equal(program, VOLTR_VAULT_PROGRAM_ADDRESS);
      assert.equal(getStrategyInitReceiptSize(), 8 + 184);
      assert.deepEqual(config, {
        encoding: "base64",
        commitment: "confirmed",
        filters: [
          { dataSize: 192n },
          { memcmp: { offset: 8n, bytes: vaultAddress, encoding: "base58" } },
          {
            memcmp: {
              offset: 72n,
              bytes: DRIFT_ADAPTOR_PROGRAM_ID,
              encoding: "base58",
            },
          },
        ],
      });
      const receipt = snapshot.accounts.strategy_init_receipt!;
      return [
        {
          pubkey: receipt.address,
          account: fixture.accounts.get(receipt.address),
        },
      ];
    },
  });
  fixture.accounts.set(
    golden.claimantTokenAccount,
    tokenAccount(address(golden.vaultStrategyAuth), 1234567n),
  );
  const load = async (claimant: string) => {
    assert.equal(claimant, golden.vaultStrategyAuth);
    return fixture.args.eligibility;
  };
  const result = await queryDfxStatus(fixture.ctx, {
    vault: vaultAddress,
    loadEligibility: load,
  });
  assert.equal(discoveryCalls, 1);
  assert.equal(result.strategies.length, 1);
  const status = result.strategies[0]!;
  assert.equal(status.strategy, golden.strategy);
  assert.equal(status.vaultStrategyAuth, golden.vaultStrategyAuth);
  assert.deepEqual(status.claimantTokenAccount, {
    address: golden.claimantTokenAccount,
    exists: true,
    balanceDfx: "1.234567",
    balanceBaseUnits: "1234567",
  });
  assert.equal(status.allocations[0]!.claimed, false);
  assert.equal(status.allocations[0]!.amountBaseUnits, "428519051459");
  assert.equal(status.allocations[0]!.amountDfx, "428519.051459");
  assert.doesNotThrow(() => JSON.stringify(result));

  // A pre-funded, system-owned PDA is still claimable on-chain.
  fixture.accounts.set(
    golden.claimStatus,
    encodedAccount(address("11111111111111111111111111111111"), new Uint8Array()),
  );
  const prefunded = await queryDfxStatus(fixture.ctx, {
    vault: vaultAddress,
    strategy: strategyAddress,
    loadEligibility: load,
  });
  assert.equal(prefunded.strategies[0]!.allocations[0]!.claimed, false);

  fixture.accounts.set(golden.claimStatus, claimStatusAccount());
  const claimed = await queryDfxStatus(fixture.ctx, {
    vault: vaultAddress,
    strategy: strategyAddress,
    loadEligibility: load,
  });
  assert.equal(discoveryCalls, 1, "explicit strategy skips discovery");
  assert.equal(claimed.strategies[0]!.allocations[0]!.claimed, true);
  assert.equal(
    claimed.strategies[0]!.allocations[0]!.claimStatus,
    golden.claimStatus,
  );
});

test("status handles API 404 as no allocation and reports missing claimant ATA", async () => {
  const { ctx, accounts } = await createClaimFixture();
  accounts.delete(golden.claimantTokenAccount);
  const result = await queryDfxStatus(ctx, {
    vault: vaultAddress,
    strategy: strategyAddress,
    loadEligibility: (claimant) =>
      loadEligibility({
        claimant,
        fetchFn: async () =>
          new Response(JSON.stringify({ error: "user not found" }), {
            status: 404,
          }),
      }),
  });
  assert.equal(result.strategies[0]!.allocationStatus, "no allocation");
  assert.deepEqual(result.strategies[0]!.allocations, []);
  assert.equal(result.strategies[0]!.claimantTokenAccount.exists, false);
});

test("empty discovery yields an empty status without calling eligibility", async () => {
  const { ctx } = await createClaimFixture({ getProgramAccounts: () => [] });
  const result = await queryDfxStatus(ctx, {
    vault: vaultAddress,
    loadEligibility: async () => {
      throw new Error("Unexpected API access");
    },
  });
  assert.deepEqual(result, { vault: vaultAddress, strategies: [] });
});

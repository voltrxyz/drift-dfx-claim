import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountRole, address, type Address } from "@solana/kit";
import {
  getStrategyInitReceiptDecoder,
  getStrategyInitReceiptEncoder,
} from "@voltr/vault-sdk";
import { resolveDfxStrategy } from "./strategy.js";
import { createEligibilityLoader } from "./eligibility.js";
import { CliError } from "./errors.js";
import { buildDfxClaimOperation } from "../../dfx/operations.js";
import { DFX_ELIGIBILITY_API } from "../../dfx/constants.js";
import { deriveClaimStatus, deriveDfxStrategyAccounts } from "../../dfx/pda.js";
import {
  accountBytes,
  claimStatusAccount,
  createClaimFixture,
  eligibilityJson,
  encodedAccount,
  golden,
  snapshot,
  strategyAddress,
  vaultAddress,
} from "../../../test/fixtures.js";

const OTHER_STRATEGY = address("11111111111111111111111111111112");
const OTHER_DISTRIBUTOR = address("11111111111111111111111111111113");

async function strategyFixture() {
  const receipts = [snapshot.accounts.strategy_init_receipt!.address];
  const fixture = await createClaimFixture({
    getProgramAccounts: () =>
      receipts.map((pubkey) => ({
        pubkey,
        account: fixture.accounts.get(pubkey),
      })),
  });
  const responses = new Map<Address, unknown>([
    [address(golden.vaultStrategyAuth), eligibilityJson],
  ]);
  const requests: Array<string> = [];
  const loadEligibility = createEligibilityLoader({
    fetchFn: async (url) => {
      const claimant = address(
        String(url).slice(`${DFX_ELIGIBILITY_API}/`.length),
      );
      assert.equal(url, `${DFX_ELIGIBILITY_API}/${claimant}`);
      requests.push(claimant);
      return responses.has(claimant)
        ? new Response(JSON.stringify(responses.get(claimant)))
        : new Response(null, { status: 404 });
    },
  });
  async function addStrategy() {
    const derived = await deriveDfxStrategyAccounts(
      vaultAddress,
      OTHER_STRATEGY,
    );
    const original = fixture.accounts.get(receipts[0]!)!;
    const receipt = getStrategyInitReceiptDecoder().decode(
      accountBytes(original),
    );
    fixture.accounts.set(
      derived.strategyInitReceipt,
      encodedAccount(
        original.owner,
        getStrategyInitReceiptEncoder().encode({
          ...receipt,
          strategy: OTHER_STRATEGY,
        }),
      ),
    );
    receipts.push(derived.strategyInitReceipt);
    responses.set(
      derived.claimant,
      (eligibilityJson as Array<Record<string, unknown>>).map((entry) => ({
        ...entry,
        claimant: derived.claimant,
        merkle_tree: OTHER_DISTRIBUTOR,
      })),
    );
    return derived;
  }
  return {
    ...fixture,
    loadEligibility,
    responses,
    requests,
    addStrategy,
    receipts,
  };
}

for (const explicit of [false, true]) {
  test(`GOLDEN: ${explicit ? "explicit" : "auto-selected"} strategy builds the identical claim instruction`, async (context) => {
    const fixture = await strategyFixture();
    const messages: Array<string> = [];
    context.mock.method(console, "log", (message: string) =>
      messages.push(message),
    );
    const { strategy, claimant } = await resolveDfxStrategy(fixture.ctx, {
      vault: vaultAddress,
      strategy: explicit ? strategyAddress : undefined,
      loadEligibility: fixture.loadEligibility,
    });
    const operation = await buildDfxClaimOperation(fixture.ctx, {
      ...fixture.args,
      strategy,
      eligibility: await fixture.loadEligibility(claimant),
    });
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
    assert.deepEqual(fixture.requests, [golden.vaultStrategyAuth]);
    assert.deepEqual(
      messages,
      explicit
        ? []
        : [
            `Selected strategy ${golden.strategy} (vault_strategy_auth ${golden.vaultStrategyAuth}, 428519.051459 DFX in distributor ${golden.distributor})`,
          ],
    );
  });
}

test("auto-selection reports no candidate for empty discovery, API 404, non-DFX or initialized ClaimStatus", async () => {
  for (const reason of ["empty", "404", "non-dfx", "claimed"]) {
    const fixture = await strategyFixture();
    if (reason === "empty") fixture.receipts.length = 0;
    if (reason === "404") fixture.responses.clear();
    if (reason === "non-dfx")
      fixture.responses.set(
        address(golden.vaultStrategyAuth),
        (eligibilityJson as Array<Record<string, unknown>>).map((entry) => ({
          ...entry,
          mint: OTHER_DISTRIBUTOR,
        })),
      );
    if (reason === "claimed")
      fixture.accounts.set(golden.claimStatus, claimStatusAccount());
    await assert.rejects(
      resolveDfxStrategy(fixture.ctx, {
        vault: vaultAddress,
        loadEligibility: fixture.loadEligibility,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(
          error.message,
          /No unclaimed DFX allocation was found for any Drift strategy/,
        );
        assert.ok(error.message.includes(`dfx:status --vault ${golden.vault}`));
        return true;
      },
    );
  }
});

test("auto-selection lists every candidate strategy and unclaimed allocation", async () => {
  const fixture = await strategyFixture();
  const other = await fixture.addStrategy();
  await assert.rejects(
    resolveDfxStrategy(fixture.ctx, {
      vault: vaultAddress,
      loadEligibility: fixture.loadEligibility,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      for (const value of [
        golden.strategy,
        OTHER_STRATEGY,
        golden.vaultStrategyAuth,
        other.claimant,
        golden.distributor,
        OTHER_DISTRIBUTOR,
        "428519.051459 DFX",
        "--strategy",
      ])
        assert.ok(error.message.includes(value), error.message);
      return true;
    },
  );
  assert.equal(fixture.requests.length, 2);
});

test("distributor narrows auto-selection to the matching unclaimed allocation", async (context) => {
  const fixture = await strategyFixture();
  await fixture.addStrategy();
  context.mock.method(console, "log", () => {});
  assert.equal(
    (
      await resolveDfxStrategy(fixture.ctx, {
        vault: vaultAddress,
        distributor: address(golden.distributor),
        loadEligibility: fixture.loadEligibility,
      })
    ).strategy,
    golden.strategy,
  );
  assert.equal(
    (
      await resolveDfxStrategy(fixture.ctx, {
        vault: vaultAddress,
        distributor: OTHER_DISTRIBUTOR,
        loadEligibility: fixture.loadEligibility,
      })
    ).strategy,
    OTHER_STRATEGY,
  );
  assert.deepEqual(new Set(fixture.requests).size, 2);
  assert.equal(fixture.requests.length, 2);
  await assert.rejects(
    resolveDfxStrategy(fixture.ctx, {
      vault: vaultAddress,
      distributor: OTHER_STRATEGY,
      loadEligibility: fixture.loadEligibility,
    }),
    /No unclaimed DFX allocation/,
  );
});

test("auto-selection excludes initialized claims but includes a pre-funded system-owned ClaimStatus", async (context) => {
  const fixture = await strategyFixture();
  const other = await fixture.addStrategy();
  fixture.accounts.set(
    await deriveClaimStatus(other.claimant, OTHER_DISTRIBUTOR),
    claimStatusAccount(),
  );
  fixture.accounts.set(
    golden.claimStatus,
    encodedAccount(
      address("11111111111111111111111111111111"),
      new Uint8Array(),
    ),
  );
  context.mock.method(console, "log", () => {});
  const selected = await resolveDfxStrategy(fixture.ctx, {
    vault: vaultAddress,
    loadEligibility: fixture.loadEligibility,
  });
  assert.equal(selected.strategy, golden.strategy);
  assert.equal(selected.claimant, golden.vaultStrategyAuth);
});

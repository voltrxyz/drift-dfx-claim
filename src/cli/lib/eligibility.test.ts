import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { DFX_ELIGIBILITY_API } from "../../dfx/constants.js";
import {
  ELIGIBILITY_MAX_ATTEMPTS,
  loadEligibility,
  parseEligibility,
} from "./eligibility.js";
import {
  eligibilityJson,
  golden,
  managerAddress,
} from "../../../test/fixtures.js";

test("eligibility loader supports the API and local file without losing integer precision", async () => {
  const claimant = address(golden.vaultStrategyAuth);
  const api = await loadEligibility({
    claimant,
    fetchFn: async (url) => {
      assert.equal(url, `${DFX_ELIGIBILITY_API}/${claimant}`);
      return new Response(JSON.stringify(eligibilityJson));
    },
  });
  assert.equal(api[0]!.amountUnlocked, 428519051459n);
  assert.equal(api[0]!.amountLocked, 0n);
  const file = await loadEligibility({
    claimant,
    file: fileURLToPath(
      new URL("../../../test/fixtures/eligibility.json", import.meta.url),
    ),
    fetchFn: async () => {
      throw new Error("file mode must never fetch");
    },
  });
  assert.deepEqual(file, api);
});

test("eligibility distinguishes 404, server errors and malformed responses", async () => {
  const claimant = address(golden.vaultStrategyAuth);
  assert.deepEqual(
    await loadEligibility({
      claimant,
      fetchFn: async () => new Response(null, { status: 404 }),
    }),
    [],
  );
  let serverErrorCalls = 0;
  await assert.rejects(
    loadEligibility({
      claimant,
      fetchFn: async () => {
        serverErrorCalls++;
        return new Response(null, { status: 503 });
      },
      sleepFn: async () => {},
    }),
    /after 4 attempts \(last: HTTP 503\)/,
  );
  assert.equal(serverErrorCalls, ELIGIBILITY_MAX_ATTEMPTS);
  await assert.rejects(
    loadEligibility({ claimant, fetchFn: async () => new Response("<html>") }),
    /invalid JSON/,
  );
  await assert.rejects(
    loadEligibility({
      claimant: managerAddress,
      fetchFn: async () => new Response(JSON.stringify(eligibilityJson)),
    }),
    /different claimant/,
  );
  assert.throws(
    () => parseEligibility({ error: "user not found" }),
    /Invalid eligibility response/,
  );
});

test("eligibility retries transient API failures with backoff but not client errors", async () => {
  const claimant = address(golden.vaultStrategyAuth);
  const delays: Array<number> = [];
  const responses = [
    () => new Response(null, { status: 502 }),
    () => {
      throw new TypeError("fetch failed");
    },
    () => new Response(null, { status: 429 }),
    () => new Response(JSON.stringify(eligibilityJson)),
  ];
  let calls = 0;
  const entries = await loadEligibility({
    claimant,
    fetchFn: async () => responses[calls++]!(),
    sleepFn: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(calls, 4);
  assert.deepEqual(delays, [500, 1000, 2000]);
  assert.equal(entries[0]!.amountUnlocked, 428519051459n);

  let clientErrorCalls = 0;
  await assert.rejects(
    loadEligibility({
      claimant,
      fetchFn: async () => {
        clientErrorCalls++;
        return new Response(null, { status: 400 });
      },
      sleepFn: async () => {
        throw new Error("4xx must not be retried");
      },
    }),
    /HTTP 400/,
  );
  assert.equal(clientErrorCalls, 1);
});

test("eligibility rejects numeric amounts, overflow, negative amounts and malformed proofs", () => {
  const original = eligibilityJson as Array<Record<string, unknown>>;
  for (const changes of [
    { end_amount: 42 },
    { end_amount: "18446744073709551616" },
    { locked_amount: "-1" },
    { proof: [[1, 2, 3]] },
    { proof: [new Array(32).fill(256)] },
  ]) {
    assert.throws(
      () => parseEligibility([{ ...original[0], ...changes }]),
      /Invalid eligibility response/,
    );
  }
  const parsed = parseEligibility([
    { ...original[0], end_amount: "18446744073709551615" },
  ]);
  assert.equal(parsed[0]!.amountUnlocked, 18446744073709551615n);
});

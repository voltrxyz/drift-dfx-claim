// Adapted from voltr-integration-scripts packages/core/src/env.test.ts (19072d0).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asAddress,
  createScriptContext,
  optionalAddress,
  parseBigintAmount,
} from "./env.js";
import type { ScriptProfile } from "./profile.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function profile(rpcUrl?: string): ScriptProfile {
  return {
    name: "ctx-test",
    cluster: "devnet",
    rpcUrl,
    vault: {
      vaultAddress: USDC,
      assetMintAddress: USDC,
      assetTokenProgram: TOKEN_PROGRAM,
    },
  };
}

/** Run `fn` with specific env vars set/cleared, restoring originals after. */
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// --- parseBigintAmount ---

test("parseBigintAmount accepts raw integer strings", () => {
  assert.equal(parseBigintAmount("1000000"), 1_000_000n);
  assert.equal(parseBigintAmount("0"), 0n);
  assert.equal(
    parseBigintAmount("12345678901234567890"),
    12345678901234567890n,
  );
});

test("parseBigintAmount accepts numbers and bigints", () => {
  assert.equal(parseBigintAmount(5), 5n);
  assert.equal(parseBigintAmount(7n), 7n);
});

test("parseBigintAmount rejects non-integer numbers", () => {
  assert.throws(() => parseBigintAmount(1.5), /must be an integer/);
});

test("parseBigintAmount rejects non-numeric / decimal / negative strings", () => {
  assert.throws(() => parseBigintAmount("abc"), /raw integer string/);
  assert.throws(() => parseBigintAmount("1.5"), /raw integer string/);
  assert.throws(() => parseBigintAmount("-1"), /raw integer string/);
  assert.throws(() => parseBigintAmount(""), /raw integer string/);
});

// --- asAddress / optionalAddress ---

test("asAddress returns a valid address and rejects empty input", () => {
  assert.equal(asAddress(USDC), USDC);
  assert.throws(() => asAddress(""), /address is required/);
  assert.throws(
    () => asAddress("", "vault.vaultAddress"),
    /vault\.vaultAddress/,
  );
});

test("optionalAddress returns undefined for empty/undefined input", () => {
  assert.equal(optionalAddress(undefined), undefined);
  assert.equal(optionalAddress(""), undefined);
  assert.equal(optionalAddress(USDC), USDC);
});

// --- createScriptContext RPC precedence ---

test("createScriptContext prefers the explicit override URL", () => {
  withEnv({ RPC_URL: "http://env:8899", HELIUS_RPC_URL: undefined }, () => {
    const ctx = createScriptContext(
      profile("http://profile:8899"),
      "http://override:8899",
    );
    assert.equal(ctx.rpcUrl, "http://override:8899");
  });
});

test("createScriptContext falls back to RPC_URL, then HELIUS_RPC_URL", () => {
  withEnv(
    { RPC_URL: "http://env:8899", HELIUS_RPC_URL: "http://helius:8899" },
    () => {
      assert.equal(createScriptContext(profile()).rpcUrl, "http://env:8899");
    },
  );
  withEnv({ RPC_URL: undefined, HELIUS_RPC_URL: "http://helius:8899" }, () => {
    assert.equal(createScriptContext(profile()).rpcUrl, "http://helius:8899");
  });
});

test("createScriptContext falls back to the profile rpcUrl", () => {
  withEnv({ RPC_URL: undefined, HELIUS_RPC_URL: undefined }, () => {
    assert.equal(
      createScriptContext(profile("http://profile:8899")).rpcUrl,
      "http://profile:8899",
    );
  });
});

test("createScriptContext throws when no RPC URL is resolvable", () => {
  withEnv({ RPC_URL: undefined, HELIUS_RPC_URL: undefined }, () => {
    assert.throws(() => createScriptContext(profile()), /RPC URL is required/);
  });
});

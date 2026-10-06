import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadProfile,
  ScriptProfileSchema,
  resolveLookupTableAddresses,
} from "./profile.js";
import { managerAddress, vaultAddress } from "../../test/fixtures.js";

test("minimal profile and unchanged integration-scripts profiles are accepted", async () => {
  assert.equal(
    ScriptProfileSchema.parse({ vault: { vaultAddress } }).vault.vaultAddress,
    vaultAddress,
  );
  const profile = await loadProfile(
    "configs/examples/dfx.mainnet.example.json",
  );
  const richer = {
    ...profile,
    futureSetting: true,
    integrations: {
      kamino: { reserveAddress: "", other: 1 },
      trustful: { strategySeedString: "" },
    },
  };
  assert.deepEqual(ScriptProfileSchema.parse(richer), richer);
  assert.deepEqual(resolveLookupTableAddresses(profile), []);
  assert.deepEqual(
    resolveLookupTableAddresses({
      ...profile,
      vault: {
        ...profile.vault,
        useLookupTable: true,
        lookupTableAddress: managerAddress,
      },
    }),
    [managerAddress],
  );
});

test("profile requires a valid vault and a lookup table when enabled", () => {
  for (const value of [
    {},
    { vault: {} },
    { vault: { vaultAddress: "" } },
    { vault: { vaultAddress: "bad" } },
    { vault: { vaultAddress, useLookupTable: true, lookupTableAddress: "" } },
  ]) {
    assert.equal(ScriptProfileSchema.safeParse(value).success, false);
  }
});

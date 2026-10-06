import { readFileSync } from "node:fs";
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  type Address,
  type ReadonlyUint8Array,
  type Blockhash,
} from "@solana/kit";
import { getVaultDecoder, getVaultEncoder } from "@voltr/vault-sdk";
import {
  AccountState,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { createFakeRpc, type FakeRpcOptions } from "../src/core/testing.js";
import type { ScriptContext } from "../src/core/types.js";
import { parseEligibility } from "../src/cli/lib/eligibility.js";
import {
  DFX_DISCRIMINATOR,
  DFX_MINT,
  MERKLE_DISTRIBUTOR_PROGRAM_ID,
} from "../src/dfx/constants.js";

export interface RpcAccount {
  lamports: bigint;
  owner: Address;
  executable: boolean;
  data: [string, "base64"];
  space: bigint;
}

interface Snapshot {
  slot: number;
  clock: { unix_timestamp: string };
  accounts: Record<
    string,
    {
      address: string;
      account: null | {
        lamports: number;
        owner: string;
        executable: boolean;
        data: [string, "base64"];
      };
    }
  >;
}

interface Golden {
  managerSecretSeedHex: string;
  manager: string;
  vault: string;
  strategy: string;
  vaultStrategyAuth: string;
  distributor: string;
  claimStatus: string;
  distributorTokenAccount: string;
  claimantTokenAccount: string;
  recipientTokenAccount: string;
  instruction: {
    programAddress: string;
    accounts: Array<{ address: string; role: string }>;
    dataHex: string;
    dataLength: number;
  };
}

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

export const snapshot = fixture("snapshot.json") as Snapshot;
export const golden = fixture("claim-ix.golden.json") as Golden;
export const eligibilityJson = fixture("eligibility.json");
export const vaultAddress = address(golden.vault);
export const strategyAddress = address(golden.strategy);
export const managerAddress = address(golden.manager);
export const BLOCKHASH = {
  blockhash: "11111111111111111111111111111111" as Blockhash,
  lastValidBlockHeight: 999n,
};

export function tokenAccount(owner: Address, amount = 0n): RpcAccount {
  return encodedAccount(
    TOKEN_PROGRAM_ADDRESS,
    getTokenEncoder().encode({
      owner,
      mint: DFX_MINT,
      amount,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
  );
}

/** A ClaimStatus as new_claim leaves it: distributor-owned, 112 bytes, ClaimStatus discriminator. */
export function claimStatusAccount(): RpcAccount {
  const data = new Uint8Array(112);
  data.set(DFX_DISCRIMINATOR.CLAIM_STATUS);
  return encodedAccount(MERKLE_DISTRIBUTOR_PROGRAM_ID, data);
}

export function encodedAccount(
  owner: Address,
  data: ReadonlyUint8Array,
): RpcAccount {
  return {
    lamports: 2_039_280n,
    owner,
    executable: false,
    data: [Buffer.from(data).toString("base64"), "base64"],
    space: BigInt(data.length),
  };
}

export function accountBytes(account: RpcAccount): Buffer {
  return Buffer.from(account.data[0], "base64");
}

export async function createClaimFixture(
  rpcOptions: Omit<FakeRpcOptions, "getAccountInfo"> = {},
) {
  const accounts = new Map<string, RpcAccount>();
  for (const value of Object.values(snapshot.accounts)) {
    if (value.account)
      accounts.set(
        value.address,
        encodedAccount(
          address(value.account.owner),
          Buffer.from(value.account.data[0], "base64"),
        ),
      );
  }
  const manager = await createKeyPairSignerFromPrivateKeyBytes(
    Buffer.from(golden.managerSecretSeedHex, "hex"),
  );
  const vaultAccount = accounts.get(vaultAddress)!;
  const vault = getVaultDecoder().decode(accountBytes(vaultAccount));
  accounts.set(
    vaultAddress,
    encodedAccount(
      vaultAccount.owner,
      getVaultEncoder().encode({ ...vault, manager: manager.address }),
    ),
  );
  accounts.set(
    golden.claimantTokenAccount,
    tokenAccount(address(golden.vaultStrategyAuth)),
  );
  accounts.set(golden.recipientTokenAccount, tokenAccount(manager.address));
  accounts.delete(golden.claimStatus);
  const rpc = createFakeRpc({
    slot: BigInt(snapshot.slot),
    blockTime: BigInt(snapshot.clock.unix_timestamp),
    ...rpcOptions,
    getAccountInfo: (key) => ({ value: accounts.get(key) ?? null }),
  });
  const ctx: ScriptContext = { rpcUrl: "http://offline.invalid", rpc };
  // Any accidental profile read violates the operation-builder contract.
  Object.defineProperty(ctx, "profile", {
    get() {
      throw new Error("Builder read ctx.profile");
    },
  });
  const args = {
    manager,
    vault: vaultAddress,
    strategy: strategyAddress,
    recipient: manager.address,
    eligibility: parseEligibility(eligibilityJson),
  };
  return { accounts, ctx, args, manager };
}

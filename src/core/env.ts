// Adapted from voltr-integration-scripts packages/core/src/env.ts (19072d0).
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import type { ScriptProfile } from "./profile.js";
import type { ScriptContext } from "./types.js";

// RPC precedence (highest to lowest):
//   1. --rpc-url CLI flag (rpcUrlOverride)
//   2. RPC_URL env
//   3. HELIUS_RPC_URL env
//   4. profile.rpcUrl
export function resolveRpcUrl(
  rpcUrlOverride?: string,
  profileRpcUrl?: string,
): string {
  const rpcUrl =
    rpcUrlOverride ||
    process.env.RPC_URL ||
    process.env.HELIUS_RPC_URL ||
    profileRpcUrl;

  if (!rpcUrl) {
    throw new Error(
      "RPC URL is required. Pass --rpc-url, or set RPC_URL or HELIUS_RPC_URL, or add rpcUrl to the profile.",
    );
  }

  return rpcUrl;
}

export function createScriptContext(
  profile: ScriptProfile,
  rpcUrlOverride?: string,
): ScriptContext {
  const rpcUrl = resolveRpcUrl(rpcUrlOverride, profile.rpcUrl);

  return {
    profile,
    rpcUrl,
    rpc: createSolanaRpc(rpcUrl),
  };
}

export function createRpcScriptContext(rpcUrlOverride?: string): ScriptContext {
  const rpcUrl = resolveRpcUrl(rpcUrlOverride);

  return {
    rpcUrl,
    rpc: createSolanaRpc(rpcUrl),
  };
}

export async function loadSignerFromFile(
  keypairPath: string,
): Promise<KeyPairSigner> {
  const secret = Uint8Array.from(
    JSON.parse(await readFile(resolve(keypairPath), "utf8")),
  );
  return createKeyPairSignerFromBytes(secret);
}

export function asAddress(value: string, label = "address"): Address {
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return address(value);
}

export function optionalAddress(value?: string): Address | undefined {
  return value ? address(value) : undefined;
}

export function parseBigintAmount(value: string | number | bigint): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`Amount must be an integer: ${value}`);
    }
    return BigInt(value);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Amount must be a raw integer string: ${value}`);
  }
  return BigInt(value);
}

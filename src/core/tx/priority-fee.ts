// Adapted from voltr-integration-scripts packages/core/src/tx/priority-fee.ts (19072d0).
import type { PriorityFeeStrategy, SolanaRpc } from "../types.js";

export interface PriorityFeeContext {
  strategy: PriorityFeeStrategy;
  rpcUrl: string;
  rpc: SolanaRpc;
  /** Base64-encoded wire transaction. Required for Helius `getPriorityFeeEstimate`. */
  wireTransaction?: string;
  /** Writable accounts used as a hint for `getRecentPrioritizationFees`. */
  writableAccounts?: string[];
}

/**
 * Resolves a microLamports value for a transaction according to the configured
 * strategy. Returns `null` to signal that no compute-unit-price instruction
 * should be attached.
 */
export async function resolvePriorityFeeMicroLamports(
  ctx: PriorityFeeContext,
): Promise<bigint | null> {
  switch (ctx.strategy.kind) {
    case "none":
      return null;

    case "fixed":
      return ctx.strategy.microLamports;

    case "helius": {
      const fee = await tryHeliusPriorityFee(
        ctx.rpcUrl,
        ctx.wireTransaction,
        ctx.strategy.priorityLevel ?? "High",
      );
      if (fee !== null) return fee;
      return tryRpcPriorityFee(ctx.rpc, ctx.writableAccounts, {
        fallback: ctx.strategy.fallbackMicroLamports ?? 1n,
      });
    }

    case "rpc":
      return tryRpcPriorityFee(ctx.rpc, ctx.writableAccounts, {
        percentile: ctx.strategy.percentile,
        minMicroLamports: ctx.strategy.minMicroLamports,
        fallback: ctx.strategy.fallbackMicroLamports ?? 1n,
      });
  }
}

async function tryHeliusPriorityFee(
  rpcUrl: string,
  wireTransaction: string | undefined,
  priorityLevel: string,
): Promise<bigint | null> {
  if (!wireTransaction) return null;

  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "getPriorityFeeEstimate",
        params: [
          {
            transaction: wireTransaction,
            options: {
              priorityLevel,
              transactionEncoding: "base64",
            },
          },
        ],
      }),
    });
    const data = await resp.json();
    const fee = data?.result?.priorityFeeEstimate;
    if (typeof fee === "number" && Number.isFinite(fee) && fee >= 0) {
      return BigInt(Math.ceil(fee));
    }
  } catch {
    // Helius unavailable on this RPC; caller will fall back.
  }
  return null;
}

async function tryRpcPriorityFee(
  rpc: SolanaRpc,
  writableAccounts: string[] | undefined,
  opts: { percentile?: number; minMicroLamports?: bigint; fallback: bigint },
): Promise<bigint> {
  try {
    const addresses = (writableAccounts ?? []).slice(0, 128) as never;
    const fees = await rpc.getRecentPrioritizationFees(addresses).send();
    const values = fees
      .map((f) => BigInt(f.prioritizationFee))
      .filter((v) => v > 0n)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    if (values.length > 0) {
      const percentile = clampPercentile(opts.percentile ?? 75);
      const idx = Math.min(
        values.length - 1,
        Math.floor((percentile / 100) * values.length),
      );
      const picked = values[idx]!;
      const min = opts.minMicroLamports ?? 0n;
      return picked > min ? picked : min;
    }
  } catch {
    // RPC method unavailable; fall through to fallback.
  }
  return opts.fallback;
}

function clampPercentile(value: number): number {
  if (Number.isNaN(value)) return 75;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

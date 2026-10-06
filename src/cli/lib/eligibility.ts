import { readFile } from "node:fs/promises";
import { address, type Address } from "@solana/kit";
import { z } from "zod";
import { DFX_ELIGIBILITY_API } from "../../dfx/constants.js";
import type { DfxEligibilityEntry } from "../../dfx/types.js";
import { CliError } from "./errors.js";

const publicKey = z
  .string()
  .refine((value) => {
    try {
      address(value);
      return true;
    } catch {
      return false;
    }
  }, "must be a valid Solana address")
  .transform((value) => address(value));
const amount = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer string")
  .refine(
    (value) => /^\d+$/.test(value) && BigInt(value) <= (1n << 64n) - 1n,
    "must fit in a u64",
  );
const entrySchema = z
  .object({
    claimant: publicKey,
    merkle_tree: publicKey,
    mint: publicKey,
    start_ts: z.number().int().safe(),
    end_ts: z.number().int().safe(),
    proof: z.array(z.array(z.number().int().min(0).max(255)).length(32)),
    start_amount: amount,
    end_amount: amount,
    unvested_amount: amount,
    claimed_amount: amount,
    unlocked_amount_claimed: amount,
    locked_amount_withdrawn: amount,
    locked_amount: amount,
    claimable_amount: amount,
  })
  .passthrough();

export function parseEligibility(value: unknown): Array<DfxEligibilityEntry> {
  const parsed = z.array(entrySchema).safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      `Invalid eligibility response: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return parsed.data.map((entry) => ({
    claimant: entry.claimant,
    distributor: entry.merkle_tree,
    mint: entry.mint,
    amountUnlocked: BigInt(entry.end_amount),
    amountLocked: BigInt(entry.locked_amount),
    proof: entry.proof.map((node) => Uint8Array.from(node)),
  }));
}

export const ELIGIBILITY_MAX_ATTEMPTS = 4;
const ELIGIBILITY_RETRY_BASE_DELAY_MS = 500;

/** Cache the entire load, including its retry sequence, for one command run. */
export function createEligibilityLoader(
  options: Omit<Parameters<typeof loadEligibility>[0], "claimant"> = {},
): (claimant: Address) => Promise<Array<DfxEligibilityEntry>> {
  const requests = new Map<Address, Promise<Array<DfxEligibilityEntry>>>();
  return (claimant) => {
    let request = requests.get(claimant);
    if (!request) {
      request = loadEligibility({ ...options, claimant });
      requests.set(claimant, request);
    }
    return request;
  };
}

export async function loadEligibility(args: {
  claimant: Address;
  file?: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<Array<DfxEligibilityEntry>> {
  if (args.file) {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(args.file, "utf8"));
    } catch (error) {
      throw new CliError(
        `Cannot read eligibility file ${args.file}: ${(error as Error).message}`,
      );
    }
    return parseEligibility(data).filter(
      (entry) => entry.claimant === args.claimant,
    );
  }
  const response = await fetchEligibilityWithRetry(args);
  if (response.status === 404) return [];
  if (!response.ok)
    throw new CliError(
      `Eligibility API returned HTTP ${response.status} for ${args.claimant}.`,
    );
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new CliError("Eligibility API returned invalid JSON.");
  }
  const entries = parseEligibility(data);
  if (entries.some((entry) => entry.claimant !== args.claimant)) {
    throw new CliError(
      `Eligibility API returned a different claimant; expected ${args.claimant}.`,
    );
  }
  return entries;
}

// The eligibility API intermittently answers 502, so network errors, 429 and
// 5xx are retried with exponential backoff. A 404 (no allocation) and other 4xx
// responses are returned immediately.
async function fetchEligibilityWithRetry(args: {
  claimant: Address;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<Response> {
  const url = `${DFX_ELIGIBILITY_API}/${args.claimant}`;
  const fetchFn = args.fetchFn ?? fetch;
  const sleep =
    args.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastFailure = "";
  for (let attempt = 1; attempt <= ELIGIBILITY_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(ELIGIBILITY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 2));
    }
    try {
      const response = await fetchFn(url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 429 && response.status < 500) return response;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = (error as Error).message;
    }
  }
  throw new CliError(
    `Eligibility API request failed for ${args.claimant} after ${ELIGIBILITY_MAX_ATTEMPTS} attempts (last: ${lastFailure}). Retry later or pass --eligibility-file.`,
  );
}

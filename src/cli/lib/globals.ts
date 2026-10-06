// Adapted from voltr-integration-scripts apps/cli/src/lib/globals.ts (19072d0).
import { Command, Option } from "commander";
import { createRpcScriptContext, createScriptContext } from "../../core/env.js";
import { loadProfile, type ScriptProfile } from "../../core/profile.js";
import type { Address } from "@solana/kit";
import type {
  PriorityFeeStrategy,
  ProcessorOptions,
  ScriptContext,
  TxMode,
} from "../../core/types.js";
import { CliError } from "./errors.js";
import { parseAddress, parseAmount, parseCount } from "./parse.js";

export const TX_MODES = ["print", "execute", "simulate", "multisig"] as const;
export const PRIORITY_FEE_KINDS = ["helius", "rpc", "fixed", "none"] as const;

export type PriorityFeeKind = (typeof PRIORITY_FEE_KINDS)[number];

/** Options declared on the root program and shared by every command. */
export interface GlobalOptions {
  profile?: string;
  rpcUrl?: string;
  mode: TxMode;
  multisigAddress?: string;
  priorityFee: PriorityFeeKind;
  priorityFeeMicroLamports?: string;
  computeUnitLimit?: string;
  quiet?: boolean;
}

/**
 * Attach the global options to the root program. Kept here so the entry point
 * stays small and the option set is defined in exactly one place.
 */
export function addGlobalOptions(program: Command): Command {
  return program
    .addOption(
      new Option(
        "--profile <path>",
        "JSON profile path (or VOLTR_PROFILE env)",
      ).env("VOLTR_PROFILE"),
    )
    .option(
      "--rpc-url <url>",
      "RPC URL override (else RPC_URL / HELIUS_RPC_URL env, else profile.rpcUrl)",
    )
    .addOption(
      new Option("--mode <mode>", "transaction mode")
        .choices([...TX_MODES])
        .default("print"),
    )
    .option(
      "--multisig-address <address>",
      "multisig vault PDA (required for --mode multisig)",
    )
    .addOption(
      new Option("--priority-fee <kind>", "priority fee strategy")
        .choices([...PRIORITY_FEE_KINDS])
        .default("helius"),
    )
    .option(
      "--priority-fee-micro-lamports <n>",
      "microLamports for --priority-fee fixed (or fallback)",
    )
    .option(
      "--compute-unit-limit <n>",
      "override compute-unit limit (1..1400000)",
    )
    .option("--quiet", "hide transaction explorer links");
}

export interface CommandContext {
  globals: GlobalOptions;
  profile: ScriptProfile;
  ctx: ScriptContext;
}

export interface RpcCommandContext {
  globals: GlobalOptions;
  ctx: ScriptContext;
}

export function requireProfilePath(
  globals: GlobalOptions,
  options?: { command?: string },
): string {
  if (!globals.profile) {
    const command = options?.command ? ` for command "${options.command}"` : "";
    throw new CliError(`--profile <path> is required${command}.`);
  }
  return globals.profile;
}

/**
 * Load and validate the profile named by the global `--profile` flag and build
 * the RPC-backed `ScriptContext`. Used by profile-backed transaction commands
 * so the "read globals → load profile → make context" boilerplate lives in one
 * place.
 */
export async function loadCommandContext(
  program: Command,
  options?: { command?: string },
): Promise<CommandContext> {
  const globals = program.opts<GlobalOptions>();
  const profile = await loadProfile(requireProfilePath(globals, options));
  const ctx = createScriptContext(profile, globals.rpcUrl);
  return { globals, profile, ctx };
}

export function loadRpcCommandContext(program: Command): RpcCommandContext {
  const globals = program.opts<GlobalOptions>();
  const ctx = createRpcScriptContext(globals.rpcUrl);
  return { globals, ctx };
}

function parseMultisigAddress(value: string | undefined): Address | undefined {
  return value ? parseAddress(value, "--multisig-address") : undefined;
}

/**
 * Translate the priority-fee and multisig global flags into the
 * `ProcessorOptions` shape the core processor expects, validating the
 * mode-specific requirements up front so failures are actionable.
 */
export function resolveProcessorOptions(
  globals: GlobalOptions,
): ProcessorOptions {
  if (globals.mode === "multisig" && !globals.multisigAddress) {
    throw new CliError(
      "--mode multisig requires --multisig-address <pubkey> (the vault PDA that signs onchain).",
    );
  }

  const fixedMicroLamports = globals.priorityFeeMicroLamports
    ? parseAmount(
        globals.priorityFeeMicroLamports,
        "--priority-fee-micro-lamports",
      )
    : undefined;
  if (
    fixedMicroLamports !== undefined &&
    fixedMicroLamports > (1n << 64n) - 1n
  ) {
    throw new CliError("--priority-fee-micro-lamports must fit in a u64.");
  }
  const computeUnitLimit = globals.computeUnitLimit
    ? parseCount(globals.computeUnitLimit, "--compute-unit-limit")
    : undefined;
  if (computeUnitLimit !== undefined && computeUnitLimit > 1_400_000) {
    throw new CliError("--compute-unit-limit must be between 1 and 1400000.");
  }

  let priorityFee: PriorityFeeStrategy;
  switch (globals.priorityFee) {
    case "none":
      priorityFee = { kind: "none" };
      break;
    case "fixed":
      if (fixedMicroLamports == null) {
        throw new CliError(
          "--priority-fee fixed requires --priority-fee-micro-lamports <n>.",
        );
      }
      priorityFee = { kind: "fixed", microLamports: fixedMicroLamports };
      break;
    case "rpc":
      priorityFee = { kind: "rpc", fallbackMicroLamports: fixedMicroLamports };
      break;
    case "helius":
      priorityFee = {
        kind: "helius",
        fallbackMicroLamports: fixedMicroLamports,
      };
      break;
  }

  return {
    priorityFee,
    computeUnitLimit,
    multisigAddress: parseMultisigAddress(globals.multisigAddress),
    quiet: globals.quiet,
  };
}

// Adapted from voltr-integration-scripts apps/cli/src/lib/signers.ts (19072d0).
import type { Command } from "commander";
import { loadSignerFromFile } from "../../core/env.js";
import {
  createNoopSigner,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import type { GlobalOptions } from "./globals.js";
import { parseAddress } from "./parse.js";
import { CliError } from "./errors.js";

/**
 * Operational roles a command can sign as. Each maps to a `--<role>-keypair`
 * flag and a `<ROLE>_KEYPAIR` environment variable (see `.env.example`).
 */
export type Role = "admin" | "manager" | "user";

const ROLE_ENV_VAR: Record<Role, string> = {
  admin: "ADMIN_KEYPAIR",
  manager: "MANAGER_KEYPAIR",
  user: "USER_KEYPAIR",
};

/** The environment variable a role's keypair path falls back to. */
export function roleEnvVar(role: Role): string {
  return ROLE_ENV_VAR[role];
}

/** The flag a command exposes for a role's keypair path. */
export function roleFlag(role: Role): string {
  return `--${role}-keypair`;
}

/**
 * Declare the `--<role>-keypair` option on a command with one canonical wording
 * shared by every command, so the flag name, value placeholder, and help text
 * (including the env-var fallback) never drift between integrations. It is a
 * plain `option` — presence is enforced later by {@link loadRoleSigner}, which
 * also honours the `<ROLE>_KEYPAIR` env var.
 */
export function addRoleKeypairOption(command: Command, role: Role): Command {
  return command.option(
    `${roleFlag(role)} <path>`,
    `${role} keypair JSON path (or ${ROLE_ENV_VAR[role]} env)`,
  );
}

/**
 * Resolve a role's keypair path from its command flag, falling back to the
 * role's environment variable, then load the signer. Throws an actionable
 * CliError naming both the flag and env var when neither is provided, or when
 * the file cannot be read as a keypair.
 */
export async function loadRoleSigner(
  role: Role,
  flagValue?: string,
): Promise<KeyPairSigner> {
  const envVar = ROLE_ENV_VAR[role];
  const path = flagValue ?? process.env[envVar];
  if (!path) {
    throw new CliError(
      `Missing ${role} keypair. Pass ${roleFlag(role)} <path> or set ${envVar} in your environment / .env.`,
    );
  }
  try {
    return await loadSignerFromFile(path);
  } catch (error) {
    throw new CliError(
      `Failed to load ${role} keypair from "${path}": ${(error as Error).message}`,
    );
  }
}

/** A multisig signs as its vault PDA; no local manager keypair is loaded. */
export async function loadDfxManager(
  globals: GlobalOptions,
  flagValue?: string,
): Promise<{ manager: TransactionSigner; payer?: KeyPairSigner }> {
  if (globals.mode === "multisig") {
    if (!globals.multisigAddress)
      throw new CliError("--mode multisig requires --multisig-address.");
    return {
      manager: createNoopSigner(
        parseAddress(globals.multisigAddress, "--multisig-address"),
      ),
    };
  }
  const manager = await loadRoleSigner("manager", flagValue);
  return { manager, payer: manager };
}

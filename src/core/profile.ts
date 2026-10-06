// Adapted from voltr-integration-scripts packages/core/src/profile.ts (19072d0).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { address, type Address } from "@solana/kit";
import { z, type ZodIssue } from "zod";

const AddressSchema = z.string().refine(
  (value) => {
    try {
      address(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a valid base58 Solana address" },
);

const OptionalAddressSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  AddressSchema.optional(),
);

export const ScriptProfileSchema = z
  .object({
    name: z.string().optional(),
    cluster: z.string().optional(),
    rpcUrl: z.string().optional(),
    vault: z
      .object({
        vaultAddress: AddressSchema,
        useLookupTable: z.boolean().optional(),
        lookupTableAddress: OptionalAddressSchema,
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((profile, ctx) => {
    if (profile.vault.useLookupTable && !profile.vault.lookupTableAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vault", "lookupTableAddress"],
        message: "is required when vault.useLookupTable is true",
      });
    }
  });

export type ScriptProfile = z.infer<typeof ScriptProfileSchema>;

export class ProfileValidationError extends Error {
  constructor(
    public readonly profilePath: string,
    public readonly issues: ZodIssue[],
  ) {
    const formatted = issues
      .map((issue) => {
        const path = issue.path.length ? issue.path.join(".") : "(root)";
        return `  - ${path}: ${issue.message}`;
      })
      .join("\n");
    super(`Profile validation failed for ${profilePath}:\n${formatted}`);
    this.name = "ProfileValidationError";
  }
}

export class ProfileFieldError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly field: string,
    options?: { command?: string; hint?: string },
  ) {
    const command = options?.command ? ` for command "${options.command}"` : "";
    const hint = options?.hint ? `\nHint: ${options.hint}` : "";
    super(
      `Profile "${profileName}" is missing required field "${field}"${command}.${hint}`,
    );
    this.name = "ProfileFieldError";
  }
}

export async function loadProfile(profilePath: string): Promise<ScriptProfile> {
  const resolvedPath = resolve(profilePath);
  let raw: string;
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read profile at ${resolvedPath}: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Profile ${resolvedPath} is not valid JSON: ${(error as Error).message}`,
    );
  }

  const result = ScriptProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProfileValidationError(resolvedPath, result.error.issues);
  }

  return result.data;
}

export interface AccessOptions {
  command?: string;
}

export function requireVaultAddress(profile: ScriptProfile): Address {
  return address(profile.vault.vaultAddress);
}

export function requireLookupTableAddress(
  profile: ScriptProfile,
  options?: AccessOptions,
): Address {
  if (!profile.vault.lookupTableAddress) {
    throw new ProfileFieldError(
      profile.name ?? "(unnamed)",
      "vault.lookupTableAddress",
      {
        ...options,
        hint: "Set vault.lookupTableAddress in the profile, or disable vault.useLookupTable.",
      },
    );
  }
  return address(profile.vault.lookupTableAddress);
}

export function resolveLookupTableAddresses(
  profile: ScriptProfile,
  options?: AccessOptions,
): Address[] {
  if (!profile.vault.useLookupTable) {
    return [];
  }
  return [requireLookupTableAddress(profile, options)];
}

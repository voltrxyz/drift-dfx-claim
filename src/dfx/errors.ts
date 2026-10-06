import { DRIFT_ADAPTOR_PROGRAM_ID } from "./constants.js";

export const DFX_UPGRADE_HINT = `The Drift adaptor ${DRIFT_ADAPTOR_PROGRAM_ID} on this cluster does not have claim_dfx yet (upgrade pending). Confirm the adaptor upgrade is live before retrying.`;

export function hasDfxUpgradeError(logs: ReadonlyArray<string>): boolean {
  const programs: Array<string> = [];
  for (const line of logs) {
    const invocation = /^Program (\w+) invoke \[\d+\]/.exec(line);
    if (invocation) programs.push(invocation[1]!);
    if (
      programs.at(-1) === DRIFT_ADAPTOR_PROGRAM_ID &&
      /InstructionFallbackNotFound|Error Number: 101\b/.test(line)
    )
      return true;
    if (
      line.startsWith(`Program ${DRIFT_ADAPTOR_PROGRAM_ID} failed:`) &&
      /custom program error: (?:0x65|101)\b/.test(line)
    )
      return true;
    if (/^Program \w+ (?:success|failed:)/.test(line)) programs.pop();
  }
  return false;
}

export function getErrorLogs(
  error: unknown,
  seen = new Set<unknown>(),
): Array<string> {
  if (!error || typeof error !== "object" || seen.has(error)) return [];
  seen.add(error);
  const object = error as Record<string, unknown>;
  return [
    ...(Array.isArray(object.logs)
      ? object.logs.filter((line): line is string => typeof line === "string")
      : []),
    ...getErrorLogs(object.context, seen),
    ...getErrorLogs(object.cause, seen),
    ...getErrorLogs(object.data, seen),
  ];
}

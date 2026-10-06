import { test } from "node:test";
import assert from "node:assert/strict";
import { DRIFT_ADAPTOR_PROGRAM_ID } from "./constants.js";
import { getErrorLogs, hasDfxUpgradeError } from "./errors.js";

const fallback =
  "Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound. Error Number: 101. Error Message: Fallback functions are not supported.";
test("upgrade hint detects error 101 in the Drift adaptor's logs only", () => {
  const logs = [
    `Program ${DRIFT_ADAPTOR_PROGRAM_ID} invoke [2]`,
    fallback,
    `Program ${DRIFT_ADAPTOR_PROGRAM_ID} failed: custom program error: 0x65`,
  ];
  assert.ok(hasDfxUpgradeError(logs));
  assert.ok(hasDfxUpgradeError([logs[2]!]));
  assert.equal(
    hasDfxUpgradeError([
      "Program 11111111111111111111111111111111 invoke [1]",
      fallback,
    ]),
    false,
  );
  assert.equal(
    hasDfxUpgradeError([
      `Program ${DRIFT_ADAPTOR_PROGRAM_ID} invoke [2]`,
      "Program log: Error Number: 6101",
    ]),
    false,
  );
  const cause = { context: { logs } };
  const error = new Error("failed", { cause });
  assert.ok(hasDfxUpgradeError(getErrorLogs(error)));
  const cycle = { cause: error };
  error.cause = cycle;
  assert.deepEqual(getErrorLogs(error), []);
});

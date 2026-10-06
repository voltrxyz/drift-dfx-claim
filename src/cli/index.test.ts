import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountRole,
  address,
  getAddressEncoder,
  getBase58Decoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { createProgram } from "./index.js";
import { resolveProcessorOptions } from "./lib/globals.js";
import {
  DFX_ELIGIBILITY_API,
  DRIFT_ADAPTOR_PROGRAM_ID,
} from "../dfx/constants.js";
import { buildMultisigPayload } from "../core/tx/multisig.js";
import {
  BLOCKHASH,
  createClaimFixture,
  eligibilityJson,
  golden,
  managerAddress,
  snapshot,
} from "../../test/fixtures.js";

function programWithThrowingErrors() {
  const program = createProgram();
  for (const command of [program, ...program.commands]) {
    command.exitOverride().configureOutput({ writeErr: () => {} });
  }
  return program;
}

test("every DFX command requires and validates --vault before RPC or signer access", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network access");
  });
  for (const command of ["dfx:status", "dfx:setup", "dfx:claim"]) {
    await assert.rejects(
      programWithThrowingErrors().parseAsync([command], { from: "user" }),
      /required option '--vault <address>' not specified/,
    );
    for (const vault of ["invalid", ""]) {
      await assert.rejects(
        programWithThrowingErrors().parseAsync([command, "--vault", vault], {
          from: "user",
        }),
        /--vault must be a valid base58 Solana address/,
      );
    }
  }
});

test("setup and claim validate --lookup-table with its flag name", async () => {
  for (const command of ["dfx:setup", "dfx:claim"]) {
    await assert.rejects(
      programWithThrowingErrors().parseAsync(
        [
          command,
          "--vault",
          golden.vault,
          "--lookup-table",
          "invalid",
          "--recipient",
          golden.manager,
        ],
        { from: "user" },
      ),
      /--lookup-table must be a valid base58 Solana address/,
    );
  }
});

for (const command of [[], ["dfx:status"], ["dfx:setup"], ["dfx:claim"]]) {
  test(`CLI help works offline: ${command.join(" ") || "root"}`, () => {
    const result = spawnSync("pnpm", ["cli", "--", ...command, "--help"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RPC_URL: "",
        MANAGER_KEYPAIR: "",
        HELIUS_RPC_URL: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    if (!command.length) assert.match(result.stdout, /--quiet/);
  });
}

test("invalid recipient/fee flags fail before keypair or RPC access", async () => {
  const program = programWithThrowingErrors();
  await assert.rejects(
    program.parseAsync(
      ["dfx:claim", "--vault", golden.vault, "--strategy", golden.strategy],
      {
        from: "user",
      },
    ),
    /exactly one of/,
  );
  await assert.rejects(
    programWithThrowingErrors().parseAsync(
      [
        "dfx:claim",
        "--vault",
        golden.vault,
        "--strategy",
        golden.strategy,
        "--recipient",
        golden.manager,
        "--recipient-token-account",
        golden.recipientTokenAccount,
      ],
      { from: "user" },
    ),
    /cannot be used with option/,
  );
  for (const computeUnitLimit of ["0", "-1", "NaN", "1400001", "1.5"]) {
    assert.throws(
      () =>
        resolveProcessorOptions({
          mode: "print",
          priorityFee: "none",
          computeUnitLimit,
        }),
      /--compute-unit-limit/,
    );
  }
  for (const priorityFeeMicroLamports of [
    "-1",
    "NaN",
    "1.5",
    "18446744073709551616",
  ]) {
    assert.throws(
      () =>
        resolveProcessorOptions({
          mode: "print",
          priorityFee: "fixed",
          priorityFeeMicroLamports,
        }),
      /--priority-fee-micro-lamports/,
    );
  }
});

test("CLI status JSON and setup modes use only an injected offline transport", async (context) => {
  const { accounts } = await createClaimFixture();
  const dir = await mkdtemp(join(tmpdir(), "dfx-cli-test-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const keypair = join(dir, "fixture-manager.json");
  await writeFile(
    keypair,
    JSON.stringify([
      ...Buffer.from(golden.managerSecretSeedHex, "hex"),
      ...getAddressEncoder().encode(managerAddress),
    ]),
  );
  const requests: Array<{ method: string; params: Array<unknown> }> = [];
  const output: Array<string> = [];
  context.mock.method(console, "log", (...values: Array<unknown>) =>
    output.push(values.map(String).join(" ")),
  );
  context.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "http://offline.invalid");
      const request = JSON.parse(String(init?.body)) as {
        id: string;
        method: string;
        params: Array<unknown>;
      };
      requests.push(request);
      let result: unknown;
      switch (request.method) {
        case "getAccountInfo":
          result = {
            context: { slot: snapshot.slot },
            value: accounts.get(String(request.params[0])) ?? null,
          };
          break;
        case "getLatestBlockhash":
          result = { context: { slot: snapshot.slot }, value: BLOCKHASH };
          break;
        case "simulateTransaction":
          result = {
            context: { slot: snapshot.slot },
            value: { err: null, logs: [], unitsConsumed: 25000 },
          };
          break;
        case "sendTransaction":
          result = getBase58Decoder().decode(new Uint8Array(64).fill(7));
          break;
        case "getSignatureStatuses":
          result = {
            context: { slot: snapshot.slot },
            value: [
              {
                slot: snapshot.slot,
                confirmations: 1,
                confirmationStatus: "confirmed",
                err: null,
              },
            ],
          };
          break;
        default:
          throw new Error(`Unexpected offline RPC method: ${request.method}`);
      }
      return new Response(
        JSON.stringify(
          { jsonrpc: "2.0", id: request.id, result },
          (_, value) => (typeof value === "bigint" ? Number(value) : value),
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const globals = ["--rpc-url", "http://offline.invalid"];
  await createProgram().parseAsync(
    [
      ...globals,
      "dfx:status",
      "--vault",
      golden.vault,
      "--strategy",
      golden.strategy,
      "--eligibility-file",
      "test/fixtures/eligibility.json",
      "--json",
    ],
    { from: "user" },
  );
  const status = JSON.parse(output.join("\n"));
  assert.equal(
    status.strategies[0].allocations[0].amountBaseUnits,
    "428519051459",
  );
  for (const mode of ["print", "simulate", "multisig", "execute"]) {
    const offset = requests.length;
    const outputOffset = output.length;
    await createProgram().parseAsync(
      [
        ...globals,
        "dfx:setup",
        "--vault",
        golden.vault,
        "--strategy",
        golden.strategy,
        "--eligibility-file",
        "/does/not/exist.json", // Explicit setup must not read eligibility at all.
        "--recipient",
        golden.manager,
        "--mode",
        mode,
        "--priority-fee",
        "fixed",
        "--priority-fee-micro-lamports",
        "1000",
        "--compute-unit-limit",
        "50000",
        "--quiet",
        ...(mode === "print" ? ["--lookup-table", golden.distributor] : []),
        ...(mode === "multisig"
          ? [
              "--multisig-address",
              golden.manager,
              "--manager-keypair",
              "/missing.json",
            ]
          : ["--manager-keypair", keypair]),
      ],
      { from: "user" },
    );
    const calls = requests.slice(offset);
    assert.equal(
      calls.filter((call) => call.method === "sendTransaction").length,
      mode === "execute" ? 1 : 0,
    );
    if (mode === "print") {
      // Setup only validates the vault and the strategy receipt before printing.
      assert.deepEqual(
        calls.map((call) => [call.method, String(call.params[0])]),
        [
          ["getAccountInfo", golden.vault],
          ["getAccountInfo", snapshot.accounts.strategy_init_receipt!.address],
        ],
      );
      assert.deepEqual(JSON.parse(output[outputOffset]!).lookupTableAddresses, [
        golden.distributor,
      ]);
    }
    if (mode === "simulate" || mode === "execute") {
      const request = calls.find(
        (call) =>
          call.method ===
          (mode === "simulate" ? "simulateTransaction" : "sendTransaction"),
      )!;
      const transaction = getTransactionDecoder().decode(
        Buffer.from(String(request.params[0]), "base64"),
      );
      assert.deepEqual(Object.keys(transaction.signatures), [golden.manager]);
      const message = getCompiledTransactionMessageDecoder().decode(
        transaction.messageBytes,
      );
      assert.equal(message.version, 0);
      assert.equal(message.instructions.length, 4);
    }
  }
  assert.equal(
    output.some((line) => line.includes("explorer:")),
    false,
  );
});

test("CLI explicit and auto-selected claims match the golden payload, use flags and surface upgrade failures offline", async (context) => {
  const { accounts } = await createClaimFixture();
  const dir = await mkdtemp(join(tmpdir(), "dfx-claim-cli-test-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const keypair = join(dir, "manager.json");
  await writeFile(
    keypair,
    JSON.stringify([
      ...Buffer.from(golden.managerSecretSeedHex, "hex"),
      ...getAddressEncoder().encode(managerAddress),
    ]),
  );
  const outputs: Array<string> = [];
  const calls: Array<string> = [];
  const eligibilityCalls: Array<string> = [];
  context.mock.method(console, "log", (...values: Array<unknown>) =>
    outputs.push(values.map(String).join(" ")),
  );
  context.mock.method(console, "error", () => {});
  context.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      if (
        String(input) === `${DFX_ELIGIBILITY_API}/${golden.vaultStrategyAuth}`
      ) {
        eligibilityCalls.push(golden.vaultStrategyAuth);
        return new Response(JSON.stringify(eligibilityJson));
      }
      assert.equal(String(input), "http://offline.invalid");
      const request = JSON.parse(String(init?.body)) as {
        id: string;
        method: string;
        params: Array<unknown>;
      };
      calls.push(request.method);
      let result: unknown;
      switch (request.method) {
        case "getProgramAccounts": {
          const receipt = snapshot.accounts.strategy_init_receipt!;
          result = [
            { pubkey: receipt.address, account: accounts.get(receipt.address) },
          ];
          break;
        }
        case "getAccountInfo":
          result = {
            context: { slot: snapshot.slot },
            value: accounts.get(String(request.params[0])) ?? null,
          };
          break;
        case "getSlot":
          result = snapshot.slot;
          break;
        case "getBlockTime":
          result = Number(snapshot.clock.unix_timestamp);
          break;
        case "getLatestBlockhash":
          result = { context: { slot: snapshot.slot }, value: BLOCKHASH };
          break;
        case "simulateTransaction":
          result = {
            context: { slot: snapshot.slot },
            value: {
              err: { InstructionError: [0, { Custom: 101 }] },
              unitsConsumed: 1000,
              logs: [
                `Program ${DRIFT_ADAPTOR_PROGRAM_ID} invoke [2]`,
                "Program log: AnchorError: InstructionFallbackNotFound. Error Number: 101.",
                `Program ${DRIFT_ADAPTOR_PROGRAM_ID} failed: custom program error: 0x65`,
              ],
            },
          };
          break;
        default:
          throw new Error(`Unexpected RPC call: ${request.method}`);
      }
      return new Response(
        JSON.stringify(
          { jsonrpc: "2.0", id: request.id, result },
          (_, value) => (typeof value === "bigint" ? Number(value) : value),
        ),
      );
    },
  );
  const base = [
    "--rpc-url",
    "http://offline.invalid",
    "dfx:claim",
    "--vault",
    golden.vault,
    "--strategy",
    golden.strategy,
    "--recipient",
    golden.manager,
    "--eligibility-file",
    "test/fixtures/eligibility.json",
    "--priority-fee",
    "none",
    "--quiet",
  ];
  await createProgram().parseAsync(
    [
      ...base,
      "--mode",
      "multisig",
      "--multisig-address",
      golden.manager,
      "--manager-keypair",
      "/does/not/exist.json",
    ],
    { from: "user" },
  );
  assert.ok(outputs.some((line) => line.includes("bytes: 1161/1232")));
  const payload = outputs
    .find((line) => line.startsWith("  base64:"))!
    .slice("  base64: ".length);
  const expected = buildMultisigPayload({
    multisigAddress: managerAddress,
    blockhash: BLOCKHASH,
    instructions: [
      {
        programAddress: address(golden.instruction.programAddress),
        accounts: golden.instruction.accounts.map((account) => ({
          address: address(account.address),
          role: AccountRole[account.role as keyof typeof AccountRole],
        })),
        data: Buffer.from(golden.instruction.dataHex, "hex"),
      },
    ],
  });
  assert.equal(
    payload,
    expected.base64Transaction,
    "explicit strategy preserves every transaction byte",
  );
  assert.equal(
    eligibilityCalls.length,
    0,
    "file mode never contacts eligibility API",
  );
  const tx = getTransactionDecoder().decode(Buffer.from(payload, "base64"));
  assert.deepEqual(Object.keys(tx.signatures), [golden.manager]);
  assert.equal(tx.signatures[managerAddress], null);

  const globalFlags = [
    "--rpc-url",
    "http://offline.invalid",
    "--mode",
    "multisig",
    "--multisig-address",
    golden.manager,
    "--priority-fee",
    "fixed",
    "--priority-fee-micro-lamports",
    "1000",
    "--compute-unit-limit",
    "50000",
    "--quiet",
  ];
  const autoClaim = [
    "dfx:claim",
    "--vault",
    golden.vault,
    "--recipient",
    golden.manager,
    "--manager-keypair",
    "/does/not/exist.json",
  ];
  for (const flagsFirst of [true, false]) {
    const outputOffset = outputs.length;
    const apiOffset: number = eligibilityCalls.length;
    await createProgram().parseAsync(
      flagsFirst
        ? [...globalFlags, ...autoClaim]
        : [...autoClaim, ...globalFlags],
      { from: "user" },
    );
    const printed = outputs.slice(outputOffset);
    assert.equal(
      printed[0],
      `Selected strategy ${golden.strategy} (vault_strategy_auth ${golden.vaultStrategyAuth}, 428519.051459 DFX in distributor ${golden.distributor})`,
    );
    assert.equal(
      printed.find((line) => line.startsWith("  base64:")),
      `  base64: ${expected.base64Transaction}`,
    );
    assert.deepEqual(eligibilityCalls.slice(apiOffset), [
      golden.vaultStrategyAuth,
    ]);
    assert.equal(
      printed.some((line) => line.includes("explorer:")),
      false,
    );
  }

  // Setup uses the same auto-selection with a local eligibility file.
  const setupOffset = outputs.length;
  await createProgram().parseAsync(
    [
      ...globalFlags,
      "dfx:setup",
      "--vault",
      golden.vault,
      "--distributor",
      golden.distributor,
      "--recipient",
      golden.manager,
      "--eligibility-file",
      "test/fixtures/eligibility.json",
    ],
    { from: "user" },
  );
  assert.ok(
    outputs[setupOffset]!.startsWith(`Selected strategy ${golden.strategy}`),
  );
  assert.ok(
    outputs
      .slice(setupOffset)
      .some((line) => line === `  claimant: ${golden.vaultStrategyAuth}`),
  );
  assert.equal(eligibilityCalls.length, 2);

  // Print mode exposes exactly the builder's lookupTableAddresses without fetching the LUT.
  const printOffset = outputs.length;
  await createProgram().parseAsync(
    [
      ...base,
      "--lookup-table",
      golden.distributor,
      "--manager-keypair",
      keypair,
    ],
    { from: "user" },
  );
  assert.deepEqual(JSON.parse(outputs[printOffset]!).lookupTableAddresses, [
    golden.distributor,
  ]);
  for (const mode of ["simulate", "execute"]) {
    await assert.rejects(
      createProgram().parseAsync(
        [...base, "--mode", mode, "--manager-keypair", keypair],
        { from: "user" },
      ),
      /does not have claim_dfx yet \(upgrade pending\)/,
    );
  }
  assert.equal(calls.includes("sendTransaction"), false);
});

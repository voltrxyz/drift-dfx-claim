import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAddressEncoder,
  getBase58Decoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { createProgram } from "./index.js";
import { resolveProcessorOptions } from "./lib/globals.js";
import { DRIFT_ADAPTOR_PROGRAM_ID } from "../dfx/constants.js";
import {
  BLOCKHASH,
  createClaimFixture,
  golden,
  managerAddress,
  snapshot,
} from "../../test/fixtures.js";

const profilePath = "configs/examples/dfx.mainnet.example.json";

function programWithThrowingErrors() {
  const program = createProgram();
  for (const command of [program, ...program.commands]) {
    command.exitOverride().configureOutput({ writeErr: () => {} });
  }
  return program;
}

for (const command of [
  [],
  ["check"],
  ["dfx:status"],
  ["dfx:setup"],
  ["dfx:claim"],
]) {
  test(`CLI help works offline: ${command.join(" ") || "root"}`, () => {
    const result = spawnSync("pnpm", ["cli", "--", ...command, "--help"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RPC_URL: "",
        MANAGER_KEYPAIR: "",
        VOLTR_PROFILE: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    if (!command.length) assert.match(result.stdout, /--quiet/);
  });
}

test("CLI check validates the example without RPC or keypair", () => {
  const result = spawnSync(
    "pnpm",
    ["cli", "--", "--profile", profilePath, "check"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        RPC_URL: "",
        HELIUS_RPC_URL: "",
        MANAGER_KEYPAIR: "/does/not/exist",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Profile is valid/);
});

test("VOLTR_PROFILE is honored and invalid recipient/fee flags fail before keypair or RPC access", async (context) => {
  const old = process.env.VOLTR_PROFILE;
  process.env.VOLTR_PROFILE = profilePath;
  context.after(() => {
    if (old === undefined) delete process.env.VOLTR_PROFILE;
    else process.env.VOLTR_PROFILE = old;
  });
  context.mock.method(console, "log", () => {});
  const envProgram = createProgram();
  await envProgram.parseAsync(["check"], { from: "user" });
  assert.equal(envProgram.opts().profile, profilePath);
  const program = programWithThrowingErrors();
  await assert.rejects(
    program.parseAsync(["dfx:claim", "--strategy", golden.strategy], {
      from: "user",
    }),
    /exactly one of/,
  );
  await assert.rejects(
    programWithThrowingErrors().parseAsync(
      [
        "dfx:claim",
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
  const globals = [
    "--profile",
    profilePath,
    "--rpc-url",
    "http://offline.invalid",
  ];
  await createProgram().parseAsync(
    [
      ...globals,
      "dfx:status",
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
    await createProgram().parseAsync(
      [
        ...globals,
        "dfx:setup",
        "--strategy",
        golden.strategy,
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
    if (mode === "print") assert.equal(calls.length, 0);
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

test("CLI claim uses the multisig address without a keypair and surfaces adaptor upgrade failures", async (context) => {
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
  context.mock.method(console, "log", (...values: Array<unknown>) =>
    outputs.push(values.map(String).join(" ")),
  );
  context.mock.method(console, "error", () => {});
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
      calls.push(request.method);
      let result: unknown;
      switch (request.method) {
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
    "--profile",
    profilePath,
    "--rpc-url",
    "http://offline.invalid",
    "dfx:claim",
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
  const tx = getTransactionDecoder().decode(Buffer.from(payload, "base64"));
  assert.deepEqual(Object.keys(tx.signatures), [golden.manager]);
  assert.equal(tx.signatures[managerAddress], null);
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

# Drift DFX claim

Claim **DFX** allocations for Voltr vaults that used the Drift adaptor. Drift's merkle distributor identifies a claimant by the Drift account authority. For these vaults, that authority is the **vault_strategy_auth** PDA derived from the vault and strategy.

The CLI reaches the adaptor's `claim_dfx` through the vault's `initialize_strategy` instruction. The adaptor funds ClaimStatus rent from the manager role signer, claims DFX, and forwards the newly claimed amount to the chosen recipient. An existing balance in the claimant token account stays there.

DFX is the classic SPL Token mint `dfxQsZjikuu5DGXPgX7yEpRog74HT5cJgytT3i5iLtw`, with six decimals. Amounts in output include DFX and exact base units.

## Prerequisites

- The Drift adaptor (`EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP`) upgrade that adds `claim_dfx` must be live on your cluster. Until it is, claims fail with Anchor error 101 and the CLI prints an upgrade-pending hint.
- The vault and its Drift StrategyInitReceipt must already exist.
- A manager **or vault admin** Solana JSON keypair, with SOL for fees and rent. At current mainnet rent, ClaimStatus rent is about 0.0012 SOL and each DFX ATA about 0.0015 SOL (clusters with default rent charge about 0.0017 and 0.002 SOL). 0.01 SOL covers setup plus a claim. Pass either role's keypair through `--manager-keypair` or `MANAGER_KEYPAIR`; the vault's `initialize_strategy` accepts manager or admin.
- An RPC endpoint for the vault's cluster that supports account reads and block times. Discovery also needs `getProgramAccounts`.
- Node.js 22+ and pnpm 9, with the dependencies in `pnpm-lock.yaml` installed. For a new online checkout, run `pnpm install --frozen-lockfile`.

## Configuration

Copy the environment template:

```bash
cp .env.example .env
```

Set these values in `.env` or your shell:

```dotenv
RPC_URL=https://your-solana-rpc-endpoint
MANAGER_KEYPAIR=/absolute/path/to/manager-or-admin.json
```

RPC precedence is `--rpc-url` > `RPC_URL` > `HELIUS_RPC_URL`. The RPC URL determines the cluster. `--manager-keypair` overrides `MANAGER_KEYPAIR` and accepts either the vault manager's or admin's keypair. Keep keypairs outside the repository; `.env` is ignored by Git.

Every DFX command requires `--vault <address>`. There is deliberately no environment fallback for the vault: each invocation must name the vault being acted on. Global options, including `--rpc-url`, `--mode` and fee settings, work before or after the subcommand.

## Claim workflow

Replace these values with your vault and the owner who should receive its DFX. The shell variables below are only shorthand for explicit flag values:

```bash
export VAULT='YOUR_VOLTR_VAULT_ADDRESS'
export RECIPIENT='YOUR_RECIPIENT_OWNER_ADDRESS'
```

Discover the vault's Drift strategies and allocations. Status is read-only and needs no signer:

```bash
pnpm cli -- dfx:status --vault "$VAULT"
pnpm cli -- dfx:status --vault "$VAULT" --json
```

If exactly one Drift strategy has an unclaimed DFX allocation, setup and claim select it automatically and print its strategy, claimant, amount and distributor before building:

```bash
# Preview, then create the claimant and recipient ATAs in a separate transaction.
pnpm cli -- dfx:setup --vault "$VAULT" --recipient "$RECIPIENT"
pnpm cli -- dfx:setup --vault "$VAULT" --recipient "$RECIPIENT" --mode execute

# Verify the allocation, recipient, program logs and compute consumption.
pnpm cli -- dfx:claim --vault "$VAULT" --recipient "$RECIPIENT" --mode simulate

# Send the claim using the same signer as both manager role and fee payer.
pnpm cli -- dfx:claim --vault "$VAULT" --recipient "$RECIPIENT" --mode execute

pnpm cli -- dfx:status --vault "$VAULT"
```

If several strategies qualify, the command lists them with their unclaimed allocations and asks for `--strategy <address>`. If none qualify, inspect `dfx:status --vault "$VAULT"`. An explicit strategy also filters status, and lets setup run without fetching eligibility:

```bash
export STRATEGY='YOUR_DRIFT_STRATEGY_ADDRESS'
pnpm cli -- dfx:status --vault "$VAULT" --strategy "$STRATEGY"
pnpm cli -- dfx:setup --vault "$VAULT" --strategy "$STRATEGY" --recipient "$RECIPIENT"
pnpm cli -- dfx:claim --vault "$VAULT" --strategy "$STRATEGY" --recipient "$RECIPIENT" --mode simulate
```

`dfx:setup` creates ATAs idempotently and permits off-curve owners, including Squads vault PDAs. Omit `--recipient` to create only the claimant ATA. The claim transaction contains one vault instruction; it does not create token accounts. Setup and claim are separate because of transaction size.

Use exactly one recipient option. `--recipient <owner>` resolves the owner's DFX ATA. `--recipient-token-account <address>` uses an existing DFX token account directly, including a non-ATA. The recipient account must have a different owner from the claimant PDA.

If one strategy has several unclaimed DFX allocations, claim lists their distributor addresses. Select one with `--distributor <address>` and claim each allocation separately. On both setup and claim, `--distributor` also narrows automatic strategy selection to unclaimed allocations in that distributor.

**Trust note:** the full newly claimed allocation goes to the selected recipient token account. It is not automatically credited to vault depositors or returned to the vault. Verify the destination in the printed metadata before execution.

## Modes and fees

- `print` is the default. It prints instruction count, lookup tables and metadata. Claim preflight still reads the RPC and eligibility API; a manager or admin keypair is required to identify the signer.
- `simulate` signs locally and asks the RPC to simulate, without sending a transaction. It prints logs and compute consumption, and exits nonzero if simulation fails.
- `execute` prints metadata before sending, simulates for compute estimation, adds a compute limit with a 10% margin unless overridden, resolves the priority fee, signs, sends and confirms.
- `multisig` emits unsigned Base58 and base64 transactions for the named PDA. It loads no local keypair and sends nothing.

All modes accept `--compute-unit-limit <n>`. It affects simulate/execute; multisig strips compute-budget instructions because the execution wrapper supplies them. The priority-fee options are `--priority-fee helius|rpc|fixed|none` and `--priority-fee-micro-lamports <n>`. The default attempts Helius estimation against your RPC, falls back to recent RPC fees, then to 1 microLamport per compute unit. With `fixed`, the amount flag is required. `--quiet` hides explorer links while retaining metadata, logs and payloads.

```bash
pnpm cli -- dfx:claim --vault "$VAULT" --recipient "$RECIPIENT" \
  --mode simulate --priority-fee fixed --priority-fee-micro-lamports 1000
```

## Eligibility files and preflight

The default eligibility source is `https://dfx.drift.trade/api/eligibility/<vault_strategy_auth>`. HTTP 404 means no allocation. The API intermittently returns 502, so network errors, HTTP 429 and 5xx are retried up to four attempts with backoff; other HTTP failures and malformed data fail the command. Results are cached per claimant for each command run, so claim construction reuses the response loaded during automatic selection.

Status, claim and setup's automatic selection accept `--eligibility-file <path>` containing the API's JSON array. A file may combine entries for several claimants into one array; entries are filtered to each claimant. This avoids the HTTP request, but account checks still require RPC access. Setup with an explicit `--strategy` does not load eligibility from either source.

```bash
pnpm cli -- dfx:status --vault "$VAULT" --eligibility-file ./eligibility.json
pnpm cli -- dfx:claim --vault "$VAULT" --recipient "$RECIPIENT" \
  --eligibility-file ./eligibility.json --mode simulate
```

The claim builder checks manager/admin authorization, the strategy receipt's Drift adaptor, distributor ownership/discriminator/mint, activation slot, clawback state, and the claim window. It uses the confirmed slot and that block's timestamp, failing if the RPC cannot provide a time. Both `start_ts` and `end_ts` must have passed to avoid early-claim forfeiture.

It verifies the merkle proof locally against the onchain root using `end_amount` as `amount_unlocked` and `locked_amount` as `amount_locked`. DFX's locked amount must be zero. An allocation counts as claimed only when an initialized, distributor-owned ClaimStatus exists onchain, so stale API claimed fields do not control selection and lamports sent to the ClaimStatus address do not block a claim. It also checks claimant/recipient token ownership, mint, program, initialized/unfrozen state, and the distributor token vault's balance.

## Multisig

Use the **Squads vault PDA that is vault.manager or vault.admin**, not the Squads configuration address or a member's wallet. It occupies both the manager and payer accounts in the claim instruction, so it pays the ATA and ClaimStatus rent and must hold SOL.

```bash
export MULTISIG='YOUR_SQUADS_VAULT_PDA'

pnpm cli -- dfx:setup --vault "$VAULT" --recipient "$RECIPIENT" \
  --mode multisig --multisig-address "$MULTISIG"

# Import and execute setup in Squads before building the claim.
export LOOKUP_TABLE='YOUR_POPULATED_LOOKUP_TABLE_ADDRESS'
pnpm cli -- dfx:claim --vault "$VAULT" --recipient "$RECIPIENT" \
  --mode multisig --multisig-address "$MULTISIG" --lookup-table "$LOOKUP_TABLE"
```

Import the emitted Base58 transaction into your multisig frontend and review its accounts, allocation and recipient. Payload generation does not create or execute a Squads proposal.

The fixture claim is **1,161 bytes** as a legacy transaction and **1,213 bytes** with compute-unit limit and price instructions. Simulate/execute follow the template's v0 format, which measures **1,215 bytes** with both budget instructions and no LUT. Solana's limit is **1,232 bytes**. These sizes depend on proof length and the selected accounts.

The multisig `bytes` line measures the import transaction, not the Squads execution wrapper. Wrapping a roughly 1.16 KB claim likely needs an address lookup table. Pass `--lookup-table <address>` to use an existing table containing the claim's nonsigner accounts. Both setup and claim accept this flag; include it on each invocation that should use the table. The processor fetches and uses it in simulate, execute and multisig modes. The CLI does not create/extend LUTs or estimate the final Squads wrapper; ensure the chosen frontend and execution flow use the table.

## Troubleshooting

- **Already claimed:** the error names the ClaimStatus account and distributor when you explicitly select a claimed allocation. Automatic selection skips it. Use `dfx:status --vault "$VAULT"` to inspect allocations, or select another distributor.
- **No allocation / 404:** check the vault, strategy and derived claimant address. Claims belong to `vault_strategy_auth`, not the manager wallet. A local file must contain an entry for that claimant.
- **Multiple strategies:** pass `--strategy <address>` from the candidate list, or narrow selection with `--distributor <address>`.
- **Missing claimant or recipient ATA:** run `dfx:setup --vault "$VAULT"` with the same strategy and recipient, execute it, then rebuild the claim. A claim simulation cannot use unexecuted setup instructions.
- **Adaptor not upgraded:** Anchor error 101 / `InstructionFallbackNotFound` from the Drift adaptor prints an upgrade-pending hint. Confirm the cluster and upgrade, then rebuild and simulate.
- **Early claim:** wait until the distributor's start and end timestamps have passed. The command refuses claims that could forfeit part of the allocation.
- **Proof mismatch:** refresh the eligibility response. The onchain root must validate the claimant and exact allocation; do not change the amounts or proof.
- **Signer mismatch:** use either the vault manager or vault admin keypair, or the matching multisig vault PDA.
- **Transaction too large:** keep setup separate. Use a populated lookup table for larger proofs or multisig execution.

## Development and verification

```bash
pnpm cli -- --help
pnpm cli -- dfx:claim --help
pnpm cli -- dfx:status --help
pnpm typecheck
pnpm test
pnpm check
```

The single-package layout separates `src/cli` (flags, files, eligibility HTTP, strategy selection and output), `src/core` (RPC context, signers and transaction pipeline), and `src/dfx` (PDA derivation, account/proof validation, queries and operation builders). Builders accept explicit args, may read RPC, and perform no filesystem I/O or sending.

Tests use Node's test runner through tsx. They serve the pinned snapshot at slot 453526241 through a fake RPC, patch its manager with the SDK encoder, and compare the instruction to a golden instruction taken from voltr-drift-adaptor's LiteSVM test, which executes it against the mainnet vault and distributor binaries. CLI simulation/execution tests use intercepted HTTP with fake responses; they never contact a cluster. The suite covers explicit and automatic strategy selection, eligibility caching/retries, required flags, RPC precedence, preflight failures, discovery filters, API 404, ATA setup, byte sizes, LUT use, error hints and offline help.

The `cli` script uses `node --import tsx src/cli/index.ts`. This runs TypeScript directly without the standalone tsx launcher's IPC socket, allowing help to run in restricted sandboxes.

Shared files were adapted from `voltr-integration-scripts` commit `19072d0`; each copied source file has a provenance comment. There are no runtime imports from sibling repositories.

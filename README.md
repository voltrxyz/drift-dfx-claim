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

## Profile and environment

Reuse your integration-scripts JSON profile unchanged, or copy the example:

```bash
cp configs/examples/dfx.mainnet.example.json configs/my-vault.json
cp .env.example .env
```

Edit `vault.vaultAddress` to your vault. The example contains the pinned test-fixture vault. Only `vault.vaultAddress` is required; other integration-scripts fields pass through. `vault.lookupTableAddress` is required if `vault.useLookupTable` is true. `cluster` is a display label; the RPC URL determines the actual cluster.

Set these values in `.env` or your shell:

```dotenv
VOLTR_PROFILE=configs/my-vault.json
RPC_URL=https://your-solana-rpc-endpoint
MANAGER_KEYPAIR=/absolute/path/to/manager-or-admin.json
```

`--profile` overrides `VOLTR_PROFILE`. RPC precedence matches integration-scripts: `--rpc-url`, `RPC_URL`, `HELIUS_RPC_URL`, then `profile.rpcUrl`. Keypair flags override environment variables. Keep keypairs outside the repository; `.env` and local profiles are ignored by Git.

Validate the profile offline, without an RPC or keypair:

```bash
pnpm cli -- --profile configs/examples/dfx.mainnet.example.json check
pnpm cli -- check
```

## Claim workflow

First discover the vault's Drift strategies and allocations. This command is read-only and needs no signer:

```bash
pnpm cli -- dfx:status
pnpm cli -- dfx:status --json
```

Choose a strategy from the output and the owner who should receive its DFX. Replace the two values before running these commands:

```bash
export STRATEGY='YOUR_DRIFT_STRATEGY_ADDRESS'
export RECIPIENT='YOUR_RECIPIENT_OWNER_ADDRESS'

pnpm cli -- dfx:status --strategy "$STRATEGY"

# Preview, then create the claimant and recipient ATAs in a separate transaction.
pnpm cli -- dfx:setup --strategy "$STRATEGY" --recipient "$RECIPIENT"
pnpm cli -- dfx:setup --strategy "$STRATEGY" --recipient "$RECIPIENT" --mode execute

# Verify the allocation, recipient, program logs and compute consumption.
pnpm cli -- dfx:claim --strategy "$STRATEGY" --recipient "$RECIPIENT" --mode simulate

# Send the claim using the same signer as both manager role and fee payer.
pnpm cli -- dfx:claim --strategy "$STRATEGY" --recipient "$RECIPIENT" --mode execute

pnpm cli -- dfx:status --strategy "$STRATEGY"
```

`dfx:setup` creates ATAs idempotently and permits off-curve owners, including Squads vault PDAs. Omit `--recipient` to create only the claimant ATA. The claim transaction contains one vault instruction; it does not create token accounts. Setup and claim are separate because of transaction size.

Use exactly one recipient option. `--recipient <owner>` resolves the owner's DFX ATA. `--recipient-token-account <address>` uses an existing DFX token account directly, including a non-ATA. The recipient account must have a different owner from the claimant PDA.

If several unclaimed DFX allocations exist, the command lists their distributor addresses. Select one with `--distributor <address>` and claim each allocation separately.

**Trust note:** the full newly claimed allocation goes to the selected recipient token account. It is not automatically credited to vault depositors or returned to the vault. Verify the destination in the printed metadata before execution.

## Modes and fees

- `print` is the default. It prints instruction count, lookup tables and metadata. Claim preflight still reads the RPC and eligibility API; a manager or admin keypair is required to identify the signer.
- `simulate` signs locally and asks the RPC to simulate, without sending a transaction. It prints logs and compute consumption, and exits nonzero if simulation fails.
- `execute` simulates for compute estimation, adds a compute limit with a 10% margin unless overridden, resolves the priority fee, signs, sends and confirms.
- `multisig` emits unsigned Base58 and base64 transactions for the named PDA. It loads no local keypair and sends nothing.

All modes accept `--compute-unit-limit <n>`. It affects simulate/execute; multisig strips compute-budget instructions because the execution wrapper supplies them. The priority-fee options are `--priority-fee helius|rpc|fixed|none` and `--priority-fee-micro-lamports <n>`. The default attempts Helius estimation against your RPC, falls back to recent RPC fees, then to 1 microLamport per compute unit. With `fixed`, the amount flag is required. `--quiet` hides explorer links while retaining metadata, logs and payloads.

```bash
pnpm cli -- dfx:claim --strategy "$STRATEGY" --recipient "$RECIPIENT" \
  --mode simulate --priority-fee fixed --priority-fee-micro-lamports 1000
```

## Eligibility files and preflight

The default eligibility source is `https://dfx.drift.trade/api/eligibility/<vault_strategy_auth>`. HTTP 404 means no allocation. The API intermittently returns 502, so network errors, HTTP 429 and 5xx are retried up to four attempts with backoff; other HTTP failures and malformed data fail the command.

Both status and claim accept `--eligibility-file <path>` containing the API's JSON array. A file may combine arrays for several claimants; entries are filtered to the selected claimant. This avoids the HTTP request, but account checks still require RPC access.

```bash
pnpm cli -- dfx:status --strategy "$STRATEGY" --eligibility-file ./eligibility.json
pnpm cli -- dfx:claim --strategy "$STRATEGY" --recipient "$RECIPIENT" \
  --eligibility-file ./eligibility.json --mode simulate
```

The claim builder checks manager/admin authorization, the strategy receipt's Drift adaptor, distributor ownership/discriminator/mint, activation slot, clawback state, and the claim window. It uses the confirmed slot and that block's timestamp, failing if the RPC cannot provide a time. Both `start_ts` and `end_ts` must have passed to avoid early-claim forfeiture.

It verifies the merkle proof locally against the onchain root using `end_amount` as `amount_unlocked` and `locked_amount` as `amount_locked`. DFX's locked amount must be zero. An allocation counts as claimed only when an initialized, distributor-owned ClaimStatus exists onchain, so stale API claimed fields do not control selection and lamports sent to the ClaimStatus address do not block a claim. It also checks claimant/recipient token ownership, mint, program, initialized/unfrozen state, and the distributor token vault's balance.

## Multisig

Use the **Squads vault PDA that is vault.manager or vault.admin**, not the Squads configuration address or a member's wallet. It occupies both the manager and payer accounts in the claim instruction, so it pays the ATA and ClaimStatus rent and must hold SOL.

```bash
export MULTISIG='YOUR_SQUADS_VAULT_PDA'

pnpm cli -- dfx:setup --strategy "$STRATEGY" --recipient "$RECIPIENT" \
  --mode multisig --multisig-address "$MULTISIG"

# Import and execute setup in Squads before building the claim.
pnpm cli -- dfx:claim --strategy "$STRATEGY" --recipient "$RECIPIENT" \
  --mode multisig --multisig-address "$MULTISIG"
```

Import the emitted Base58 transaction into your multisig frontend and review its accounts, allocation and recipient. Payload generation does not create or execute a Squads proposal.

The fixture claim is **1,161 bytes** as a legacy transaction and **1,213 bytes** with compute-unit limit and price instructions. Simulate/execute follow the template's v0 format, which measures **1,215 bytes** with both budget instructions and no LUT. Solana's limit is **1,232 bytes**. These sizes depend on proof length and the selected accounts.

The multisig `bytes` line measures the import transaction, not the Squads execution wrapper. Wrapping a roughly 1.16 KB claim likely needs an address lookup table. Configure `vault.useLookupTable: true` and `vault.lookupTableAddress` to use an existing table containing the claim's nonsigner accounts. The processor fetches and uses it in simulate, execute and multisig modes. The CLI does not create/extend LUTs or estimate the final Squads wrapper; ensure the chosen frontend and execution flow use the table.

## Troubleshooting

- **Already claimed:** the error names the ClaimStatus account and distributor. Use `dfx:status` to inspect the allocation, or select another distributor.
- **No allocation / 404:** check the vault, strategy and derived claimant address. Claims belong to `vault_strategy_auth`, not the manager wallet. A local file must contain an entry for that claimant.
- **Missing claimant or recipient ATA:** run `dfx:setup` with the same strategy and recipient, execute it, then rebuild the claim. A claim simulation cannot use unexecuted setup instructions.
- **Adaptor not upgraded:** Anchor error 101 / `InstructionFallbackNotFound` from the Drift adaptor prints an upgrade-pending hint. Confirm the cluster and upgrade, then rebuild and simulate.
- **Early claim:** wait until the distributor's start and end timestamps have passed. The command refuses claims that could forfeit part of the allocation.
- **Proof mismatch:** refresh the eligibility response. The onchain root must validate the claimant and exact allocation; do not change the amounts or proof.
- **Signer mismatch:** use either the vault manager or vault admin keypair, or the matching multisig vault PDA.
- **Transaction too large:** keep setup separate. Use a populated lookup table for larger proofs or multisig execution.

## Development and verification

```bash
pnpm cli -- --help
pnpm cli -- dfx:claim --help
pnpm typecheck
pnpm test
pnpm check
```

The single-package layout separates `src/cli` (flags, files, eligibility HTTP and output), `src/core` (profiles and transaction pipeline), and `src/dfx` (PDA derivation, account/proof validation, queries and operation builders). Builders accept explicit args, may read RPC, and perform no filesystem I/O, sending or profile lookup.

Tests use Node's test runner through tsx. They serve the pinned snapshot at slot 453526241 through a fake RPC, patch its manager with the SDK encoder, and compare the instruction to a golden instruction taken from voltr-drift-adaptor's LiteSVM test, which executes it against the mainnet vault and distributor binaries. CLI simulation/execution tests use intercepted HTTP with fake responses; they never contact a cluster. The suite covers preflight failures, discovery filters, API 404, ATA setup, byte sizes, LUT use, error hints and offline help/profile validation.

The `cli` script uses `node --import tsx src/cli/index.ts`. This runs TypeScript directly without the standalone tsx launcher's IPC socket, allowing help and profile validation to run in restricted sandboxes.

Shared files were adapted from `voltr-integration-scripts` commit `19072d0`; each copied source file has a provenance comment. There are no runtime imports from sibling repositories.

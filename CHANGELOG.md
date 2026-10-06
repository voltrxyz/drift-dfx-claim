# Changelog

## 0.2.0

- Require an explicit `--vault` on every DFX command and replace JSON profiles with command flags.
- Auto-select the only Drift strategy with an unclaimed DFX allocation when `--strategy` is omitted; support `--distributor` to narrow selection.
- Reuse eligibility results per claimant within each command, retaining API retries with backoff.
- Accept `--lookup-table` for setup and claim, and resolve RPC from the flag or environment.
- Validate the vault in `dfx:status` and the vault plus Drift strategy receipt in `dfx:setup`, so a mistyped address fails instead of reporting no strategies or funding an unrelated ATA.

## 0.1.0

- Add `dfx:status`, `dfx:setup`, `dfx:claim` and offline profile validation.
- Validate DFX claims against distributor state, local merkle proofs, manager/admin authorization and token accounts.
- Support print, simulate, multisig and execute modes, including configured lookup tables and an adaptor-upgrade error hint.
- Retry transient eligibility API failures (network errors, HTTP 429/5xx) with backoff.
- Add offline golden-instruction, transaction-size, preflight, CLI and profile tests using a pinned mainnet snapshot.

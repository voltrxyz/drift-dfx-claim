# Changelog

## 0.1.0

- Add `dfx:status`, `dfx:setup`, `dfx:claim` and offline profile validation.
- Validate DFX claims against distributor state, local merkle proofs, manager/admin authorization and token accounts.
- Support print, simulate, multisig and execute modes, including configured lookup tables and an adaptor-upgrade error hint.
- Retry transient eligibility API failures (network errors, HTTP 429/5xx) with backoff.
- Add offline golden-instruction, transaction-size, preflight, CLI and profile tests using a pinned mainnet snapshot.

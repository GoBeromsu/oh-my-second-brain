# Contract lineage: snapshot and event storage over 1000 seals

This record measures the disk cost of contract lineage. Every seal appends one event to `lineage/events.jsonl`, and it installs a snapshot under `generations/<digest>/`, addressed by its manifest digest. Snapshots are never deleted. Two seals of an identical manifest share one snapshot, and this record measures how much that sharing (dedup) saves. It is not a release gate.

## How it was measured

- **Command.** `npm run build && node scripts/bench/lineage-snapshots.mjs 1000`, run against the built kernel (`dist/kernel/contract/{store,lineage,generation-snapshot}.js`).
- **Isolation.** Each run seals into its own temporary store root and removes it afterwards. `HOME` and `USERPROFILE` pointed at a temporary directory, so the home store was never touched.
- **Seals.** Each seal is a real `sealContract` call with `lineageAppender` as its `onSealed` hook, the same path `oms setup` takes.
- **Contracts.**
  - **fixture:** the contract-vault fixture's shape, with one folder, one property and one Meeting template.
  - **synthetic 10-template:** ten templates, thirty properties and ten folders; each template requires six properties and three headings.
- **Workloads.**
  - **changing:** every seal changes one property meaning, so every seal installs a new snapshot.
  - **unchanged:** the same contract is resealed 1000 times.
- **Columns.**
  - **with dedup:** the logical bytes of every snapshot directory actually kept, taken from `snapshotInventory`.
  - **without dedup:** the sum over all seals of the logical bytes of the snapshot each seal installed. That is what the store would hold if every seal kept its own copy.
  - **disk:** allocated blocks under `generations/`, directories included.
  - **ms per seal:** wall time divided by 1000. It includes the bench's own per-seal size walk.

## Environment

| Item | Value |
|---|---|
| Machine | Apple M1 Pro, 10 cores, 16 GiB |
| OS | macOS 26.4.1 (Darwin 25.4.0), arm64, APFS |
| Node | v24.21.0 |
| Date | 2026-09-29 |
| Load | Busy: other builds and tests ran in the same session; the 1-minute load average was about 6.5 on 10 cores when the run ended |

## Results (1000 seals)

| Contract | Workload | One snapshot | Snapshots kept | Snapshot bytes, with dedup | Snapshot bytes, without dedup | Snapshot disk, with dedup | Lineage log | ms per seal |
|---|---|---|---|---|---|---|---|---|
| fixture | changing | 883 B | 1000 | 884,890 B | 884,890 B | 16,384,000 B | 576,719 B (577 B/event) | 254 |
| fixture | unchanged | 883 B | 1 | 883 B | 883,000 B | 16,384 B | 576,719 B (577 B/event) | 95 |
| synthetic 10-template | changing | 13,181 B | 1000 | 13,182,890 B | 13,182,890 B | 57,344,000 B | 1,487,719 B (1488 B/event) | 450 |
| synthetic 10-template | unchanged | 13,181 B | 1 | 13,181 B | 13,181,000 B | 57,344 B | 1,487,719 B (1488 B/event) | 204 |

On the changing workload the two byte columns match. The total is slightly above 1000 times one snapshot because the changed property meaning carries the seal number: snapshots are 1 byte larger from the 11th seal and 2 bytes larger from the 101st.

## What the numbers say

- **Dedup is all-or-nothing per manifest.** It saves nothing when every seal changes the contract. On a reseal of an unchanged contract it keeps one snapshot instead of 1000, a 1000x saving.
- **Block size dominates on disk.** A snapshot is a directory of small files. On APFS each file takes at least one 4 KiB block, so an 883-byte fixture snapshot allocates 16 KiB and a 13 KiB synthetic snapshot allocates 56 KiB. At 1000 changing generations that is about 16 MB and 57 MB.
- **The lineage log grows on every seal, deduplicated or not.** It costs 577 B per event for the fixture and 1488 B per event for the synthetic contract, so 1000 seals add about 0.6 MB and 1.5 MB.
- **Seal cost is fsync-bound and grows with the snapshot count.** A single fixture seal in isolation takes about 120-150 ms, mostly waiting on fsync. Every seal also runs `observeLineage`, which calls `snapshotInventory` (`src/kernel/contract/generation-snapshot.ts`) to lstat and size every kept snapshot. That work grows linearly with the number of snapshots, so the changing workloads, which end with 1000 snapshots, cost more per seal than the unchanged ones, which keep one. Seals are interactive and rare, so this is recorded rather than optimised here.

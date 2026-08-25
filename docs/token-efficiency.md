Part of [lattice](../README.md). Moved from the README on 2026-08-24; anchors preserved.

The README keeps the [real-captures table](../README.md#token-efficiency); the synthetic-fixture measurements live here.

### Synthetic fixtures

| Capture | Nodes | Capture bytes | Summary view | Reduction |
|---|---|---|---|---|
| `test/fixtures/capture/minimal.json` | 1 | 738 | 400 | 46% |
| `test/fixtures/capture/multi-frame.json` | 4 | 1537 | 801 | 48% |
| `test/fixtures/capture/with-derived.json` | 3 | 1676 | 642 | 62% |
| `test/fixtures/capture/verdict.golden.json` | 2 | 1758 | 647 | 63% |
| `syntheticCapture()` (the quickstart page) | 130 | 60637 | 31425 | 48% |

`verdict.golden.json` is named for the consumer whose capture step produced its shape, the sibling repo [apatureai/verdict](https://github.com/apatureai/verdict). It is frozen JSON like the other three; nothing in this package depends on that repo.

A page summary describes the whole page, so halving it is about the ceiling. The bounded views are where the design pays off, on the same synthetic page against the same 60637-byte baseline, with no token budget applied:

| View | Bytes | Est. tokens | Reduction vs capture |
|---|---|---|---|
| `patchContext` (1 ref) | 1439 | 360 | 97.6% |
| `actionMap` | 3394 | 849 | 94.4% |
| `focus` (1 ref, radius 2) | 4155 | 1039 | 93.1% |
| `violations` | 20355 | 5089 | 66.4% |
| `summary` | 31425 | 7857 | 48.2% |

The second table is exactly what `node examples/quickstart.mjs` prints; the first comes from `test/eval.synthetic-page.test.ts`, which re-derives it on every run. Read the numbers carefully:

- Token counts are `⌈chars/4⌉` estimates, clearly labelled as such throughout the code. They are ports; a real consumer injects model-native counters.
- The baseline is raw structured context only. It contains no image tokens, so this table is **not** a comparison against a screenshot-based prompt.
- The invariant "every view is smaller than its capture" is a test (`test/eval.synthetic-page.test.ts`). It fails the build if a future change reintroduces the regression that `views@2` fixed, when view text canonicalized whole fused nodes including the entire `evidence[]` chain and a summary came out *larger* than its input.
- Compression is not free of information. What is dropped is provenance the model cannot use, and it stays retrievable in the snapshot under the same ref the view emitted.

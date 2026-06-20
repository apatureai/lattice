# Apature UI Graph — Architecture

Created: 2026-06-16
Revised: 2026-06-18
Status: normative representation-layer architecture

## 1. Architecture Summary

UI Graph is a deterministic package inside the Judgment Engine processing boundary. It receives authorized, versioned observations; emits an immutable content-addressed graph; and renders task-focused views. It does not capture a browser, invoke a model, act on a UI, store canonical UI DNA, or deliver product findings.

The architecture separates:

- evidence production;
- representation and compression;
- model judgment;
- product workflow and action.

## 2. System Boundary

```mermaid
flowchart LR
  subgraph DNA["apatureai/ui-dna"]
    D1["Canonical DNA schema"]
    D2["Extraction and approval"]
    D3["Approved GraphProjection"]
  end

  subgraph Engine["apatureai/judgment-engine"]
    E1["Capture sandbox"]
    E2["DOM, AX, layout, styles, screenshots"]
    E3["Optional OCR, parser, embeddings"]
    E4["Artifact store and authorization"]
    E5["Prompt assembly and model inference"]
    E6["Eval, feedback, and agent memory"]
  end

  subgraph Graph["apatureai/ui-graph package"]
    G1["Validate and normalize"]
    G2["Fuse evidence"]
    G3["Build bounded scene graph"]
    G4["Project supplied UI DNA"]
    G5["Canonical snapshot and hash"]
    G6["Focused views, diffs, deltas"]
  end

  subgraph Products["Product surfaces"]
    P1["gate"]
    P2["mcp-review"]
    P3["pointer"]
    P4["interactive-review"]
  end

  D1 --> D2 --> D3
  E1 --> E2
  E2 --> G1
  E3 --> G1
  D3 --> G4
  G1 --> G2 --> G3 --> G4 --> G5 --> G6
  G5 --> E4
  G6 --> E5
  E5 --> P1
  E5 --> P2
  G6 --> P3
  G6 --> P4
  E5 --> E6
```

Hard boundary:

- optional parser/embedding arrows enter UI Graph as data;
- UI Graph has no outgoing call to a model or browser;
- products receive views through their owning service boundary, not unrestricted artifact-store access.

## 3. Component Model

```mermaid
flowchart TD
  A["BuildUiGraphRequest"] --> B["Contract validator"]
  B --> C["Coordinate and source normalizer"]
  C --> D["Candidate generator"]
  D --> E["Evidence fusion"]
  E --> F["Hierarchy and region builder"]
  F --> G["Bounded relation builder"]
  G --> H["UI-DNA projector"]
  H --> I["ID and element-ref allocator"]
  I --> J["Canonical serializer"]
  J --> K["SHA-256 snapshot"]
  K --> L["View renderer"]
  K --> M["Diff and lineage matcher"]
  M --> N["Typed delta encoder"]
```

All stages are deterministic for byte-identical normalized inputs and versioned policies.

## 4. Build Sequence

```mermaid
sequenceDiagram
  participant Product as Product surface
  participant Engine as Judgment Engine
  participant DNA as UI DNA
  participant Graph as UI Graph package
  participant Store as Artifact store

  Product->>Engine: Submit review or observe intent
  Engine->>Engine: Capture and redact rendered UI
  Engine->>DNA: Resolve approved GraphProjection
  DNA-->>Engine: Projection schema, DNA version, and digest
  Engine->>Engine: Optional OCR, parser, or embedding observations
  Engine->>Graph: buildUiGraph(capture, dna, options)
  Graph->>Graph: Validate, normalize, fuse, relate, project, hash
  Graph-->>Engine: UIGraphSnapshot and build metrics
  Engine->>Store: Persist immutable blob and metadata index
  Engine->>Graph: queryUiGraph(snapshot, viewSpec, optional comparison)
  Graph-->>Engine: Budgeted view and evidence requests
  Engine->>Store: Resolve authorized crops if needed
  Engine->>Engine: Assemble prompt and run model
  Engine-->>Product: Findings with graph refs and evidence
```

UI Graph is called after capture and before inference. It does not change the asynchronous Judgment Engine job contract.

## 5. Data Flow and Trust Labels

```mermaid
flowchart LR
  A["DOM and layout observations"] --> F["Source-fused node facts"]
  B["Accessibility observations"] --> F
  C["Computed style and text"] --> F
  D["Screenshot coordinate refs"] --> F
  E["Optional derived observations"] --> F
  F --> G["Bounded nodes, edges, regions"]
  H["Approved UI-DNA GraphProjection"] --> I["DNA projection"]
  G --> I
  I --> J["Immutable UIGraphSnapshot"]
  J --> K["Task-focused view"]
  K --> L["UNTRUSTED_UI_CONTENT blocks"]
  K --> M["Trusted schema and provenance"]
  K --> N["Authorized evidence requests"]
```

Trust rules:

- schema, policy versions, and builder-generated provenance are trusted control data;
- DOM, AX, OCR, parser labels, and visible text are untrusted customer/page data;
- production DNA is authoritative only when supplied through the approved projection contract; non-canonical eval fixtures remain advisory;
- evidence artifacts remain protected resources, not embedded trust.

## 6. Canonical Snapshot and Query Views

```mermaid
flowchart TD
  A["One capture + one DNA version"] --> B["Canonical full snapshot"]
  B --> C["summary view"]
  B --> D["violations view"]
  B --> E["focus refs view"]
  B --> F["actionMap view"]
  B --> G["patchContext view"]
  B --> H["diff against another snapshot"]
  C --> I["View cache keyed by snapshot and spec hashes"]
  D --> I
  E --> I
  F --> I
  G --> I
```

The full snapshot is reusable and task-neutral. Views are lossy, budgeted, and versioned.

## 7. Evidence Fusion

```mermaid
flowchart TD
  A["Structured source linkage exists"] -->|yes| B["Merge by explicit backend or source ID"]
  A -->|no| C["Same frame and compatible overlap?"]
  C -->|yes| D["Check role, text, and semantic compatibility"]
  D -->|compatible| E["Merge with separate evidence claims"]
  D -->|conflict| F["Keep separate nodes or facts and flag conflict"]
  C -->|no| G["Attach as AX-only or visual-only candidate"]
  B --> H["Aggregate confidence conservatively"]
  E --> H
  F --> H
  G --> H
```

Source competence:

| Fact | Preferred evidence | Fallback |
|---|---|---|
| Accessible role/name/state | Accessibility tree | DOM semantics, parser label |
| Geometry and clipping | Layout/DOM snapshot | Parser box |
| Paint/stacking | Layout/paint snapshot | Pixel evidence |
| Computed typography/color | Computed style | Pixel/OCR observation as advisory |
| Canvas/image-only elements | Parser/OCR observation | Document-level visual region |
| Canonical token/rule | UI DNA | `unknown` |

No source globally outranks another.

## 8. Stable References and Lineage

### 8.1 Snapshot-local refs

```mermaid
flowchart LR
  A["Source observations"] --> B["Deterministic nodeId"]
  B --> C["Short elementRef scoped to snapshot"]
  C --> D["Consumer finding or pointer"]
  D --> E{"Same snapshot?"}
  E -- "yes" --> F["Resolve node, geometry, evidence"]
  E -- "no" --> G["Reject stale_or_foreign_ref"]
```

### 8.2 Cross-snapshot lineage

```mermaid
flowchart TD
  A["Base node"] --> B["Generate candidates in target snapshot"]
  B --> C["Score explicit IDs, role/name, ancestry, DNA, text, geometry"]
  C --> D{"Top score above threshold and margin?"}
  D -- "yes" --> E["High-confidence match"]
  D -- "no, close candidates" --> F["Ambiguous"]
  D -- "no candidates" --> G["Removed or abstained"]
```

The architecture intentionally separates citation identity from cross-capture matching. A wrong stable ref is more damaging than a missing match.

## 9. Storage Architecture

```mermaid
flowchart LR
  A["Canonical snapshot JSON"] --> B["Object storage blob"]
  B --> C["Content hash"]
  C --> D["Metadata row"]
  D --> E["Tenant, repo, route, viewport, capture, DNA versions"]
  B --> F["Regenerated in-memory or spatial index"]
  B --> G["Focused view cache"]
  H["Screenshots, crops, vectors"] --> I["Separate authorized artifacts"]
  G --> I
```

MVP storage:

- immutable JSON blob in Judgment Engine’s object store;
- metadata/index row in its operational database;
- optional regenerated spatial/text index;
- no canonical graph database;
- no signed or expiring URL inside graph content.

Why:

- snapshots are immutable and naturally content-addressed;
- evaluation needs reproducible frozen artifacts;
- dominant queries are bounded to one snapshot;
- a graph database adds a stateful service before cross-snapshot traversal is proven necessary.

## 10. Delta and Live Observation Flow

```mermaid
sequenceDiagram
  participant Engine as Judgment Engine or Pointer session
  participant Graph as UI Graph package
  participant Consumer as Pointer consumer

  Engine->>Graph: Build checkpoint snapshot S1
  Graph-->>Engine: hash H1
  Engine->>Graph: Build later snapshot S2
  Graph->>Graph: Match nodes and diff S1 to S2
  Graph-->>Engine: Typed delta D with base H1 and target H2
  Engine-->>Consumer: S1 then D
  Consumer->>Consumer: Validate base and apply id-keyed operations
  Consumer->>Consumer: Recompute hash H2
  alt hash matches
    Consumer->>Consumer: Accept S2
  else mismatch
    Consumer-->>Engine: Request full S2 checkpoint
  end
```

Deltas optimize transfer and repeated observation. They do not replace full snapshots or create an event-sourced ownership layer.

## 11. Prompt View and Pixel Escalation Flow

```mermaid
flowchart TD
  A["View request with token and crop budget"] --> B["Select required refs and regions"]
  B --> C["Add hierarchy, labels, nearby context, DNA facts"]
  C --> D["Rank remaining facts by task policy"]
  D --> E{"Visual ambiguity or pixel-dependent fact?"}
  E -- "no" --> F["Serialize structured view"]
  E -- "yes" --> G["Request local crop"]
  G --> H{"Dense or ambiguous target?"}
  H -- "yes" --> I["Optionally request marked overlay"]
  H -- "no" --> J["Use unmarked crop"]
  I --> F
  J --> F
  F --> K["Report tokens, crops, omissions, warnings"]
```

The renderer recommends evidence. Judgment Engine decides whether a crop enters a model call.

## 12. Security and Privacy Data Flow

```mermaid
flowchart TD
  A["Captured page content"] --> B["Judgment Engine redaction policy"]
  B --> C["UI Graph validation and sensitivity labels"]
  C --> D["Canonical graph with logical evidence refs"]
  D --> E["Prompt view renderer"]
  E --> F["Delimited UNTRUSTED_UI_CONTENT"]
  E --> G["No sensitive fields unless explicitly allowed"]
  H["Artifact request"] --> I["Judgment Engine tenant authorization"]
  I --> J["Short-lived evidence access"]
```

Defense-in-depth:

- upstream redaction before graph build;
- graph-level sensitivity labels and fail-closed rendering;
- provenance preserved for injection analysis;
- tenant authorization remains outside the graph package;
- no page content can grant itself higher trust.

## 13. Failure and Degradation Matrix

| Condition | UI Graph behavior | Consumer implication |
|---|---|---|
| Screenshot unavailable | Structured graph succeeds with warning | No pixel escalation |
| DOM/layout unavailable | Use AX/derived observations if present | Lower geometry confidence |
| AX unavailable | Structural/visual graph succeeds | Accessible semantics partial |
| Styles unavailable | No style/DNA drift certainty | Use `unknown`, not default values |
| UI DNA unavailable | Neutral graph | No design-conformance claim |
| Non-canonical DNA fixture in authorized eval | Force all matches non-authoritative | Never use for published production findings |
| Parser conflicts with DOM | Preserve both; parser remains advisory | Crop may be required |
| Capture unstable | Carry page-health warning | Judgment Engine applies confidence policy |
| Node/edge budget exceeded | Summarize/drop low-value non-structural detail | View reports truncation |
| Ref from another snapshot | Typed rejection | Requery or lineage-match |
| Delta hash mismatch | Reject target | Fetch full checkpoint |
| Sensitive content survives policy | Prompt rendering fails closed | Do not invoke model with that view |

## 14. Architecture Decision Records

### ADR-001 — Hybrid scene graph

Status: accepted

Context: AX/DOM is efficient and actionable but visually incomplete. Screenshot-only perception captures rendered truth but is expensive and weakly linked to source/UI DNA.

Decision: fuse structured observations into the canonical graph and retain pixel evidence by reference. Ingest optional parser/OCR observations only as supplied data.

Rejected:

- AX-only as canonical representation;
- screenshot-only as default;
- UI Graph-owned parser inference.

Experiment gate: R1 baseline comparison in `RESEARCH.md`.

### ADR-002 — Library inside Judgment Engine for MVP

Status: accepted

Context: a dedicated service would add network latency, auth, tenancy, deployment, and availability concerns before independent scaling is demonstrated.

Decision: ship a deterministic versioned package called by Judgment Engine.

Migration trigger: multiple independently deployed consumers require direct graph access or the package cannot meet isolation/scaling needs.

### ADR-003 — Immutable blobs plus derived indexes

Status: accepted

Context: graphs are per-capture, immutable, and queried locally. Evaluation requires frozen content-addressed artifacts.

Decision: store canonical JSON blobs and metadata/spatial indexes in Judgment Engine infrastructure.

Rejected: graph database as MVP source of truth.

Migration trigger: measured cross-snapshot traversal workload and lower total operational cost.

### ADR-004 — Deterministic persisted relations

Status: accepted

Context: learned visual grouping may improve recall but creates model/version/calibration and ownership concerns.

Decision: persist deterministic bounded relations. Learned relations are optional advisory evidence from an upstream provider.

Migration trigger: controlled experiment shows significant quality lift after latency and calibration cost.

### ADR-005 — Full snapshot, focused query-time views

Status: accepted

Context: task-specific graphs are not reusable; precomputing all views is combinatorial.

Decision: build one task-neutral full snapshot and render bounded views on demand.

Rejected: raw full graph in every prompt.

### ADR-006 — Structured UI-DNA matching before embeddings

Status: accepted

Context: exact token and rule matches are auditable; embedding similarity is useful but non-authoritative.

Decision: deterministic matches can be authoritative against approved DNA. Embeddings retrieve advisory candidates only.

Migration trigger: R6 demonstrates precision/accepted-finding gain.

### ADR-007 — Snapshot refs plus probabilistic lineage

Status: accepted

Context: selectors and browser node handles are not reliably stable across renders.

Decision: use opaque snapshot-scoped refs and separately score cross-snapshot candidates with abstention.

Rejected: claiming CSS/XPath/CDP/AX IDs are durable product identity.

### ADR-008 — Typed graph deltas

Status: accepted

Context: JSON Patch is generic, but array-index paths are brittle for canonically sorted graph collections.

Decision: use typed ID-keyed operations plus explicit header replacement with base/target schema versions and hashes; store full checkpoints.

### ADR-009 — Compression under quality constraints

Status: accepted

Context: minimum tokens alone can remove grounding-critical pixels or text.

Decision: optimize tokens, bytes, crops, latency, and cost subject to grounding and finding-quality retention gates.

Rejected: compression ratio as the sole KPI.

### ADR-010 — Agent memory remains external

Status: accepted

Context: UI Graph can expose snapshots, diffs, and lineage but should not own long-term beliefs, preferences, or feedback.

Decision: Judgment Engine owns per-repo memory and feedback. UI DNA owns canonical design intent. UI Graph provides representation artifacts they may reference.

Snapshot and delta IDs are evidence references for memory systems, not memory records. Retention, summarization, retrieval ranking, and learning from outcomes remain outside this package.

## 15. Rollout Architecture

```mermaid
flowchart LR
  A["R0 contracts and fixtures"] --> B["R1 offline benchmark"]
  B --> C{"Promotion gates pass?"}
  C -- "no" --> D["Revise representation or stop"]
  C -- "yes" --> E["R2 Judgment Engine shadow build"]
  E --> F["R3 Gate feature flag"]
  F --> G["R4 MCP Review and Pointer"]
  G --> H["R5 optional learned observations"]
```

Every rollout stage retains a full-context fallback until the next stage’s quality and security evidence is established.

## 16. Repository Ownership Matrix

| Repository | Owns | Must not delegate to UI Graph |
|---|---|---|
| `apatureai/core` | Company thesis and product sequencing | Representation implementation details |
| `apatureai/judgment-engine` | Capture, artifact storage, inference, validation, eval execution, feedback, memory, shared security | Canonical graph/schema semantics |
| `apatureai/ui-dna` | DNA schema, extraction, approval, versioned design genome | Per-capture rendered graph |
| `apatureai/ui-graph` | Representation schemas, deterministic builder/query/diff rules, refs, representation metrics | Capture, model calls, actions, canonical DNA, product delivery |
| `apatureai/gate` | GitHub orchestration and delivery | Shared graph internals |
| `apatureai/mcp-review` | Agent-facing review/recheck tools | Graph construction or browser action |
| `apatureai/pointer` | Live overlay/session UX | Canonical refs or capture/model substrate |

### 16.1 Integration readiness as of 2026-06-18

```mermaid
flowchart LR
  A["Current Judgment Engine Capture<br/>images + selector geometry + page health"] --> B["CaptureBundle v1 adapter<br/>not yet published"]
  C["UI DNA approved snapshot"] --> D["GraphProjection v1<br/>not yet published"]
  B --> E["UI Graph build contract"]
  D --> E
  E --> F["Cross-repo golden fixtures"]
  F --> G["R1 offline benchmark"]
```

The contracts in this repository are target consumer contracts. They do not assert that the current producer repositories already emit them. Integration starts only after producer-owned schemas and golden fixtures are published and version-negotiated.

## 17. Open Architecture Questions

These remain experiment-gated:

- exact deterministic grouping algorithm and thresholds;
- tokenizer/model profiles used for cost estimates;
- crop padding and Set-of-Mark policy per model;
- cross-snapshot confidence calibration;
- whether graph JSON needs a compact binary transport after MVP;
- when, if ever, a graph database is operationally justified;
- whether externally learned relations or embeddings improve Apature design judgment.

None of these questions changes the layer boundary.

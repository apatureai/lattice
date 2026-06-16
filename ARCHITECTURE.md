# Apature UI Graph Architecture

Created: 2026-06-16
Status: representation-layer architecture record

## 1. Architecture Summary

UI Graph sits between Apature's capture/model substrate and the product surfaces that need to understand rendered UI. It receives capture artifacts from `judgment-engine`, receives design standards from `ui-dna`, and emits compact graph snapshots and prompt views for Gate, MCP Review, Pointer, and later interactive surfaces.

It is a perception and representation layer. It does not own browser capture, model calls, GitHub delivery, billing, or code changes.

## 2. System Boundary

```mermaid
flowchart LR
  subgraph Engine["apatureai/judgment-engine"]
    A["Browser capture"]
    B["Screenshots and crops"]
    C["DOM geometry"]
    D["Accessibility snapshot"]
    E["Computed styles"]
    F["Qwen3-VL critique"]
    G["Eval and feedback primitives"]
  end

  subgraph DNA["apatureai/ui-dna"]
    H["Design genome"]
    I["Token index"]
    J["Component families"]
    K["Layout rules"]
  end

  subgraph Graph["apatureai/ui-graph"]
    L["Graph builder"]
    M["Element refs"]
    N["Spatial and semantic edges"]
    O["UI-DNA projection"]
    P["Prompt views"]
    Q["Token and grounding metrics"]
  end

  subgraph Products["Apature product surfaces"]
    R["gate"]
    S["mcp-review"]
    T["pointer"]
    U["interactive-review"]
  end

  A --> L
  B --> L
  C --> L
  D --> L
  E --> L
  H --> O
  I --> O
  J --> O
  K --> O
  L --> M
  L --> N
  O --> P
  P --> R
  P --> S
  M --> T
  P --> U
  Q --> G
  F --> R
```

## 3. Build Flow

```mermaid
flowchart TD
  A["CaptureBundle arrives"] --> B["Normalize DOM geometry"]
  B --> C["Merge accessibility facts"]
  C --> D["Merge computed styles"]
  D --> E["Create visible node set"]
  E --> F["Assign stable element refs"]
  F --> G["Construct spatial edges"]
  G --> H["Construct semantic edges"]
  H --> I["Project UI DNA"]
  I --> J["Attach evidence refs"]
  J --> K["Emit UIGraphSnapshot"]
  K --> L["Render prompt views"]
  L --> M["Report token and grounding metrics"]
```

Optional visual parser branch:

```mermaid
flowchart TD
  A["Low DOM or accessibility confidence"] --> B["Run screenshot parser"]
  B --> C["Create visual candidate nodes"]
  C --> D["Merge by bounding-box overlap and text match"]
  D --> E["Keep visual provenance"]
  E --> F["Attach crops or overlays on demand"]
```

## 4. Consumer Flows

### Gate

```mermaid
sequenceDiagram
  participant Gate as Gate
  participant Engine as Judgment Engine
  participant Graph as UI Graph
  participant DNA as UI DNA

  Gate->>Engine: Review current PR preview
  Engine->>DNA: Load design genome
  Engine->>Graph: buildUiGraph(capture, dna)
  Graph-->>Engine: UIGraphSnapshot and prompt views
  Engine->>Engine: Run critique with graph-backed context
  Engine-->>Gate: Findings with element refs and evidence
```

### MCP Review

```mermaid
sequenceDiagram
  participant Agent as Coding Agent
  participant MCP as MCP Review
  participant Graph as UI Graph
  participant Engine as Judgment Engine

  Agent->>MCP: "Explain and fix finding F"
  MCP->>Graph: focus(elementRefs)
  Graph-->>MCP: Local graph neighborhood and patch hints
  MCP-->>Agent: Grounded evidence and suggested code direction
  Agent->>Engine: Re-check rendered UI after change
```

### Pointer

```mermaid
flowchart LR
  A["Rendered preview"] --> B["UI Graph refs and rects"]
  B --> C["Overlay pointer"]
  C --> D["Human sees exact UI-DNA drift"]
  D --> E["Coding agent applies change outside this repo"]
```

## 5. Data Flow

```mermaid
flowchart LR
  A["Screenshot"] --> G["UIGraphSnapshot"]
  B["DOM geometry"] --> G
  C["Accessibility tree"] --> G
  D["Computed styles"] --> G
  E["Text runs"] --> G
  F["UI DNA"] --> G
  G --> H["summary"]
  G --> I["violationsOnly"]
  G --> J["focus"]
  G --> K["actionMap"]
  G --> L["patchHints"]
  H --> M["Judge prompt"]
  I --> M
  J --> N["Agent prompt"]
  L --> N
  K --> O["Interactive perception"]
```

Large artifacts stay behind refs. Prompt views contain compact text plus pointers to crops, overlays, and screenshots when needed.

## 6. Repo Ownership

| Repo | Owns | Does not own |
|---|---|---|
| `apatureai/ui-graph` | Graph schema, builder contract, prompt views, element refs, graph metrics | Capture, model calls, GitHub delivery, UI-DNA source of truth |
| `apatureai/judgment-engine` | Capture, model adapters, validation, eval, feedback, shared artifact store | Product-specific GitHub UX |
| `apatureai/ui-dna` | Design genome, token extraction, component families, design rules | Per-route rendered graph construction |
| `apatureai/gate` | PR review orchestration, sticky comment, Check Run, product packaging | Shared perception engine |
| `apatureai/mcp-review` | Agent-facing tools and workflows | Graph construction internals |
| `apatureai/pointer` | Live overlay and pointing surface | Model calls or graph schema authority |

## 7. Failure Modes

| Failure | UI Graph behavior |
|---|---|
| Capture bundle missing screenshot | Return no graph and explicit `missing_screenshot` reason |
| DOM and accessibility disagree | Keep both sources, lower confidence, require evidence refs |
| Computed styles unavailable | Build structural graph, mark design projection as partial |
| Too many nodes | Collapse repeated lists and low-salience children into regions |
| Visual parser disagrees with DOM | Preserve visual candidate as secondary evidence, do not override silently |
| Sensitive text detected | Redact in prompt views while preserving geometry |
| UI-DNA version missing | Build neutral graph without design projection |
| Prompt view exceeds budget | Drop low-salience nodes first and report truncation |

## 8. Architecture Poster

The poster source is `poster_ui_graph.html`.

Rendered artifact:

```text
ui_graph_architecture.png
```

Render rule:

- Open `poster_ui_graph.html`.
- Render at a 3020px-wide viewport.
- Screenshot the `.poster` element.
- Regenerate the PNG whenever the poster HTML or referenced icons change.

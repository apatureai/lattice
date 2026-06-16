# Apature UI Graph - Research Memo

Created: 2026-06-16
Status: research synthesis before product build

## 1. Research Question

The idea under review:

Can Apature create a unique agent product by making visual agents more efficient than regular Playwright or browser agents through a compact graphical model of the UI?

Short answer:

Yes, but only if the product is scoped as Apature's design-aware perception layer, not as a broad browser automation platform.

The broad browser-automation category is already active. The narrower opening is a rendered-UI graph that combines visual grounding, accessibility/DOM structure, computed style facts, and per-team UI DNA. That is closer to Apature's thesis and much harder for a general automation tool to care about.

## 2. What The Market Already Has

### Playwright MCP

Source: [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) and [Playwright MCP docs](https://playwright.dev/docs/getting-started-mcp)

Playwright MCP is a serious baseline. It gives agents browser automation through structured accessibility snapshots, not pixels. The official docs emphasize accessibility-tree operation, element refs, deterministic interaction, screenshots as a secondary tool, and no required vision model.

Implication for Apature:

- Do not claim "token-efficient browser context" as the whole invention.
- Do not rebuild the core browser-control surface.
- UI Graph should complement this approach by adding visual layout, computed style, design-token, and UI-DNA facts that accessibility snapshots do not encode.

### Stagehand and Browserbase

Sources: [Stagehand](https://stagehand.dev/), [Stagehand observe docs](https://docs.stagehand.dev/v3/basics/observe), and [Stagehand act docs](https://docs.stagehand.dev/v3/basics/act)

Stagehand wraps browser automation around natural-language primitives such as `act`, `extract`, `observe`, and `agent`. Browserbase adds hosted browser infrastructure, action caching, session replay, prompt observability, and production deployment. The docs also make caching a cost story: repeated actions can reuse cached resolutions instead of burning new model calls.

Implication for Apature:

- The market understands browser agents and caching.
- Apature should not compete on "tell the browser what to do in English."
- The differentiated primitive is "tell the agent what the product UI means, what violates the team's design DNA, and where to patch."

### OmniParser

Sources: [microsoft/OmniParser](https://github.com/microsoft/omniparser) and [Microsoft Research OmniParser article](https://www.microsoft.com/en-us/research/articles/omniparser-for-pure-vision-based-gui-agent/)

OmniParser turns UI screenshots into structured elements and improves grounded action generation for GUI agents. Microsoft frames it as a compact screen-parsing module that converts screenshot pixels into interpretable UI elements.

Implication for Apature:

- Screenshot-to-structure is real and validated.
- UI Graph should borrow the direction, not clone the product.
- A visual parser is most useful inside Apature when it fills DOM/accessibility gaps: canvas, screenshots, custom controls, shadow DOM, and visually important non-interactive regions.

### Set-of-Mark Prompting

Source: [Set-of-Mark paper](https://arxiv.org/abs/2310.11441)

Set-of-Mark prompting overlays marks, boxes, masks, or labels onto image regions so multimodal models can refer to visual areas more accurately.

Implication for Apature:

- Element references should be speakable, stable, and visually marked.
- UI Graph can generate annotated crops and element overlays only when needed, rather than always sending full screenshots.

### UI-TARS

Source: [UI-TARS paper](https://arxiv.org/abs/2501.12326)

UI-TARS shows that screenshot-native GUI agents are a credible research direction. The paper focuses on enhanced perception, unified action modeling, system-2 reasoning, and iterative training from action traces.

Implication for Apature:

- Vision-native GUI agents are becoming stronger.
- Apature should not bet on "models cannot see UIs."
- Apature should bet on proprietary team-specific context: UI DNA, rendered product history, accepted/rejected findings, component patterns, and agent-fix outcomes.

### browser-use and Skyvern

Sources: [browser-use](https://github.com/browser-use/browser-use) and [Skyvern](https://github.com/Skyvern-AI/skyvern)

browser-use provides browser/computer action space and recovery loops for frontier models. Skyvern automates browser workflows with LLMs, computer vision, and Playwright-compatible tooling. Both are broader automation products.

Implication for Apature:

- The category is crowded if Apature tries to become "a better browser agent."
- The company should stay close to its wedge: design judgment for generated UI and the shared representation that makes that judgment cheap and grounded.

### OSWorld

Source: [OSWorld paper](https://arxiv.org/abs/2404.07972)

OSWorld shows that multimodal computer-use agents still struggle in real environments, especially with GUI grounding and operational knowledge.

Implication for Apature:

- Grounding is still a real technical problem.
- A compact, evidence-backed graph can be valuable as agent infrastructure.
- But success must be measured on Apature tasks, not broad computer-use benchmarks.

## 3. Product Conclusion

The good product is not a general browser agent.

The good product is Apature UI Graph:

- A compact scene graph for rendered product UI.
- Built from DOM, accessibility, computed styles, screenshot evidence, UI DNA, and optional visual parsing.
- Exposed as prompt views and element references to Gate, MCP Review, Pointer, and Interactive Review.
- Measured by token reduction, grounding accuracy, design-finding precision, and agent fix success.

The unique angle is not "we see the UI." Many tools can see some version of the UI. The unique angle is "we see the UI through this team's design DNA and return the smallest grounded representation needed for judgment and repair."

## 4. Strategic Recommendation

Create the repo, but treat it as an infra/moat product, not the YC lead.

Gate remains the YC story because it has a buyer, a distribution surface, a demo loop, and a pricing path. UI Graph makes Gate and agent surfaces better, and can later become a developer-facing API if the internal usage proves that the representation is meaningfully cheaper and more reliable than raw browser snapshots plus screenshots.

## 5. Backlog Ideas

- Compare raw Playwright MCP accessibility snapshots against UI Graph prompt views on the same routes.
- Add "graph compression ratio" to every review run.
- Add `focus(elementRefs)` so agents can request just the neighborhood around a finding.
- Add optional screenshot crops and Set-of-Mark overlays for ambiguous or visual-heavy regions.
- Build a design-aware element classifier that maps screen regions to known component families.
- Record accepted/rejected graph-derived findings as training data for future per-team graph ranking.
- Evaluate on Apature tasks first: finding precision, valid element refs, token usage, and agent fix rate.

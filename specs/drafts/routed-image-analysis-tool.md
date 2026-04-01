# Spec Draft: Routed image analysis tool (`analyze_image`) over live Open Hax vision surfaces

## Summary
Build a **tool-layer image router** above the existing proxy model layer.

Instead of treating vision as a single monolithic caption call, define one structured tool:

```ts
analyze_image(input: AnalyzeImageInput): Promise<StructuredObservation>
```

The tool should:
1. classify the image into a small set of actionable categories,
2. dispatch to the cheapest branch that can satisfy the task,
3. return **structured JSON** instead of prose by default,
4. escalate to `general_vlm` only when the cheaper branch is low-confidence or mismatched.

This keeps `auto:vision` as the **general VLM fallback alias**, not the whole product.

## Why
Current vision usage is still too caption-shaped:
- it pushes diverse image tasks through one VLM surface,
- it returns prose when downstream planning wants structure,
- it cannot cheaply distinguish OCR/layout work from screenshot parsing or free-form scene understanding.

The correct decomposition is:

> **classify first, specialize second, escalate last**

## Current live inventory (observed 2026-04-01)
### Live proxy `/v1/models`
Confirmed present:
- `glm-4.6v`
- `Kimi-K2.5`
- `auto:vision`

Confirmed absent:
- `glm-5v-turbo`
- `glm-ocr`

### Rotussy `/models`
Confirmed present:
- `glm-5v-turbo`
- `glm-4.6v`
- `glm-4.5v`

Confirmed absent:
- `glm-ocr`
- `Kimi-K2.5`

## Consequence
The **tool design** can be implemented now, but the **ideal branch lineup** is only partially live.

So the spec defines two layers:
- **v0 live policy**: route over models and surfaces already reachable today.
- **v1 target policy**: promote true specialists when they are exposed by the proxy.

## Goals
### Functional
1. Provide one stable tool contract for image analysis.
2. Return structured observations suitable for downstream planning.
3. Route documents, screenshots, and free-form images differently.
4. Keep the routing policy transparent and inspectable.
5. Support low-cost first-pass classification before semantic escalation.

### Non-functional
- Prefer cheap branches when they satisfy the request.
- Keep routing deterministic enough to test.
- Preserve a single fallback path (`general_vlm`) for ambiguous cases.
- Avoid provider-specific model selection in the calling agent.

## Non-goals
- Replacing `auto:vision` in the proxy.
- Solving general GUI automation in this spec.
- Building a full OCR engine inside proxx.
- Returning only prose captions by default.

## Tool interface
### TypeScript input contract
```ts
export type AnalyzeImageTaskHint =
  | "auto"
  | "ocr"
  | "layout"
  | "ui"
  | "table"
  | "chart"
  | "describe"
  | "extract"
  | "debug";

export type AnalyzeImageSourceKind =
  | "file"
  | "url"
  | "data_url"
  | "screenshot"
  | "scan"
  | "pdf_render"
  | "unknown";

export interface AnalyzeImageInput {
  readonly source: string;
  readonly taskHint?: AnalyzeImageTaskHint;
  readonly sourceKind?: AnalyzeImageSourceKind;
  readonly maxTokens?: number;
  readonly preferFastPath?: boolean;
  readonly returnMode?: "structured" | "structured_and_prose";
}
```

### TypeScript output contract
```ts
export type ImageCategory =
  | "document"
  | "screenshot_ui"
  | "chart_table"
  | "photo_scene"
  | "unknown";

export type AnalysisRoute =
  | "ocr_layout"
  | "screenshot_parser"
  | "general_vlm"
  | "fallback";

export interface RouterSignals {
  readonly sourceKind: AnalyzeImageSourceKind;
  readonly ocrTextLength: number;
  readonly ocrLineCount: number;
  readonly textDensity: number;
  readonly layoutStructureScore: number;
  readonly uiAffinityScore: number;
  readonly documentAffinityScore: number;
  readonly photoAffinityScore: number;
}

export interface RegionObservation {
  readonly id: string;
  readonly label:
    | "title"
    | "paragraph"
    | "table"
    | "chart"
    | "code"
    | "toolbar"
    | "sidebar"
    | "panel"
    | "button"
    | "input"
    | "menu"
    | "image"
    | "unknown";
  readonly bbox?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly text?: string;
  readonly confidence: number;
}

export interface UiElementObservation {
  readonly id: string;
  readonly role:
    | "button"
    | "input"
    | "link"
    | "menu"
    | "tab"
    | "list"
    | "panel"
    | "code_view"
    | "terminal"
    | "unknown";
  readonly label?: string;
  readonly bbox?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly actionable: boolean;
  readonly confidence: number;
}

export interface StructuredObservation {
  readonly type: ImageCategory;
  readonly route: AnalysisRoute;
  readonly confidence: number;
  readonly modelUsed?: string;
  readonly ocrText?: string;
  readonly summary?: string;
  readonly regions: readonly RegionObservation[];
  readonly elements: readonly UiElementObservation[];
  readonly readingOrder: readonly string[];
  readonly candidateActions: readonly string[];
  readonly uncertainties: readonly string[];
  readonly recommendedNextStep:
    | "return_result"
    | "rerun_ocr"
    | "rerun_ui_parse"
    | "escalate_general_vlm"
    | "request_user_hint";
  readonly routerSignals: RouterSignals;
}
```

## Routing policy
### Categories
The router assigns one of:
- `document`
- `screenshot_ui`
- `chart_table`
- `photo_scene`
- `unknown`

### Cheap routing signals
The first pass should combine:
1. **Source metadata**
   - file extension / MIME type
   - whether the source is from a screenshot tool
   - whether the caller explicitly says `ocr`, `ui`, `layout`, `table`, etc.
2. **Fast OCR signal**
   - total extracted character count
   - number of lines
   - ratio of short labels vs long prose-like lines
3. **Basic layout/UI heuristics**
   - repeated short labels, menus, panes, code-like lines, tabular alignment
   - presence of toolbar/sidebar/panel language
   - presence of terminal/code/dashboard affordances

### Decision rules (v0)
Use the following approximate rule order:

1. **Document/layout** if:
   - sourceKind is `scan` or `pdf_render`, or
   - OCR is dense and layout-like, or
   - taskHint is `ocr`, `layout`, or `table`

2. **Screenshot/UI** if:
   - sourceKind is `screenshot`, or
   - OCR yields many short labels / menu terms / code pane labels / button-like strings, or
   - taskHint is `ui` or `debug`

3. **Chart/table** if:
   - OCR is sparse but aligned in rows/columns, or
   - taskHint is `chart` or `table`

4. **Photo/scene** if:
   - OCR is sparse,
   - layout signals are weak,
   - the image appears semantically visual rather than interface/document heavy

5. **Unknown** if signals conflict or confidence is low.

## Route definitions
### Route: `ocr_layout`
Use when the image is mostly text or structured document content.

#### v0 live implementation
- Use the existing OCR-style path first.
- If the OCR pass is weak but the image still looks document-like, escalate to `glm-4.6v` through `auto:vision` with a document/layout extraction prompt.

#### v1 target implementation
- Replace the first step with `glm-ocr` when it is actually exposed.

#### Expected output emphasis
- `ocrText`
- `regions`
- `readingOrder`
- `uncertainties`

### Route: `screenshot_parser`
Use when the image looks like a desktop/app/web/mobile interface.

#### v0 live implementation
- Use OCR + layout heuristics + a screenshot-structure prompt over `glm-4.6v` or `auto:vision`.
- Prefer structured extraction of panes, labels, code views, toolbar items, and actionable elements.

#### v1 target implementation
- Replace the structured-prompt approach with a true screen parser if one is introduced.

#### Expected output emphasis
- `elements`
- `candidateActions`
- `regions`
- `summary`

### Route: `general_vlm`
Use only when:
- the task genuinely requires semantic scene reasoning,
- document/UI routing fails,
- or the router confidence is low.

#### v0 live implementation
- Call `auto:vision`.
- Current practical fallback chain depends on what the live proxy exposes.

#### v1 target implementation
- Once live proxy exposure catches up, `auto:vision` should prefer `glm-5v-turbo` first.

#### Expected output emphasis
- `summary`
- `uncertainties`
- minimal structured regions unless relevant

## Output contract
Default output is **structured JSON**.

Prose is optional and secondary.

Example shape:

```json
{
  "type": "screenshot_ui",
  "route": "screenshot_parser",
  "confidence": 0.88,
  "modelUsed": "glm-4.6v",
  "ocrText": "Searcher\nEnter Search Query\nMatch Regex\n...",
  "summary": "Desktop code search app with results pane on the left and code preview on the right.",
  "regions": [
    { "id": "r1", "label": "toolbar", "confidence": 0.95 },
    { "id": "r2", "label": "panel", "confidence": 0.93 },
    { "id": "r3", "label": "code", "confidence": 0.91 }
  ],
  "elements": [
    { "id": "e1", "role": "input", "label": "Enter Search Query", "actionable": true, "confidence": 0.94 },
    { "id": "e2", "role": "button", "label": "Search", "actionable": true, "confidence": 0.92 }
  ],
  "readingOrder": ["r1", "r2", "r3"],
  "candidateActions": [
    "type query into Enter Search Query",
    "inspect selected file in code preview"
  ],
  "uncertainties": [],
  "recommendedNextStep": "return_result",
  "routerSignals": {
    "sourceKind": "screenshot",
    "ocrTextLength": 412,
    "ocrLineCount": 21,
    "textDensity": 0.73,
    "layoutStructureScore": 0.79,
    "uiAffinityScore": 0.91,
    "documentAffinityScore": 0.41,
    "photoAffinityScore": 0.08
  }
}
```

## Router pseudocode
```ts
export async function analyzeImage(input: AnalyzeImageInput): Promise<StructuredObservation> {
  const sourceKind = inferSourceKind(input);
  const routerSignals = await collectRouterSignals(input, sourceKind);
  const category = classifyImage(routerSignals, input.taskHint ?? "auto");

  switch (category.type) {
    case "document": {
      const docResult = await runDocumentRoute(input, routerSignals);
      if (docResult.confidence >= 0.8) return docResult;
      return await runGeneralVlmRoute(input, routerSignals, { reason: "low_document_confidence" });
    }
    case "screenshot_ui": {
      const uiResult = await runScreenshotRoute(input, routerSignals);
      if (uiResult.confidence >= 0.8) return uiResult;
      return await runGeneralVlmRoute(input, routerSignals, { reason: "low_ui_confidence" });
    }
    case "chart_table": {
      const chartResult = await runChartTableRoute(input, routerSignals);
      if (chartResult.confidence >= 0.8) return chartResult;
      return await runGeneralVlmRoute(input, routerSignals, { reason: "low_chart_confidence" });
    }
    case "photo_scene":
      return await runGeneralVlmRoute(input, routerSignals, { reason: "scene_semantics" });
    case "unknown":
    default:
      return await runGeneralVlmRoute(input, routerSignals, { reason: "ambiguous_router_signals" });
  }
}
```

### Signal collection pseudocode
```ts
async function collectRouterSignals(
  input: AnalyzeImageInput,
  sourceKind: AnalyzeImageSourceKind,
): Promise<RouterSignals> {
  const ocr = await cheapOcrPass(input.source);
  const ocrText = ocr.text ?? "";
  const lines = splitNonEmptyLines(ocrText);

  return {
    sourceKind,
    ocrTextLength: ocrText.length,
    ocrLineCount: lines.length,
    textDensity: estimateTextDensity(ocrText, ocr),
    layoutStructureScore: estimateLayoutStructure(lines, ocr),
    uiAffinityScore: estimateUiAffinity(lines, ocrText),
    documentAffinityScore: estimateDocumentAffinity(lines, ocr, sourceKind),
    photoAffinityScore: estimatePhotoAffinity(lines, ocrText),
  };
}
```

## v0 live branch mapping
This is the route table that matches what is reachable **today**:

| Category | First branch | Current model surface | Escalation |
|---|---|---|---|
| `document` | OCR/layout extraction | OCR prompt + `glm-4.6v` if needed | `auto:vision` |
| `screenshot_ui` | OCR + UI structure extraction | `glm-4.6v` / `auto:vision` | `auto:vision` |
| `chart_table` | OCR + table/chart extraction | `glm-4.6v` | `auto:vision` |
| `photo_scene` | general semantic analysis | `auto:vision` | stronger `auto:vision` candidate |
| `unknown` | direct escalation | `auto:vision` | none |

## v1 target branch mapping
Use this once the proxy exposes the missing specialists:

| Category | First branch | Preferred model/tool | Escalation |
|---|---|---|---|
| `document` | OCR/layout | `glm-ocr` | `glm-5v-turbo` / `auto:vision` |
| `screenshot_ui` | UI parser | dedicated screen parser | `glm-5v-turbo` |
| `chart_table` | table/chart extraction | OCR/layout specialist | `glm-5v-turbo` |
| `photo_scene` | semantic VLM | `glm-5v-turbo` | `auto:vision` fallback chain |
| `unknown` | semantic VLM | `glm-5v-turbo` | `auto:vision` |

## API / implementation placement
### Recommended placement
- **Tool contract / router logic**: consumer layer (pi extension or similar)
- **General VLM fallback alias**: proxy layer (`auto:vision`)

### Suggested implementation units
- `~/.pi/agent/extensions/analyze-image.ts` (new)
- `~/.pi/agent/extensions/vision-proxy.ts` (reuse as fallback leaf)
- optional future proxy additions for specialist model exposure

## Open questions
1. Should `screenshot_ui` stay prompt-based initially, or wait for a dedicated parser?
2. Should `chart_table` be its own route or fold into `document` for v0?
3. Should `cheapOcrPass` use the existing OCR tool directly, or a stricter low-token OCR prompt over the same surface?
4. Do we want region bbox coordinates in v0, or only semantic region IDs until a better parser exists?

## Risks
- v0 still relies on multimodal prompting rather than true specialists for some branches.
- Live model exposure is inconsistent across rotussy and the current proxy.
- Empty-content / reasoning-only response shapes may still need adapter hardening in the fallback path.

## Implementation phases
1. **Spec / contract**
   - Land this draft.
2. **v0 router implementation**
   - Implement `analyze_image` as a tool-layer router.
   - Reuse existing OCR / vision leaves.
   - Return structured JSON.
3. **v0 verification**
   - Golden tests for terminal screenshot, form screenshot, dense document, chart/table, photo.
4. **proxy exposure upgrades**
   - Expose `glm-5v-turbo` live through the proxy.
   - Promote it in `auto:vision` live rollout.
5. **specialist upgrades**
   - Add `glm-ocr` when actually served.
   - Replace prompt-based screenshot parsing with a dedicated parser if adopted.

## Affected files
### This draft
- `specs/drafts/routed-image-analysis-tool.md`

### Likely future implementation files
- `~/.pi/agent/extensions/vision-proxy.ts`
- `~/.pi/agent/extensions/analyze-image.ts`
- `src/lib/provider-strategy/strategies/vision.ts`
- `models.json`
- `src/tests/vision-auto-model.test.ts`

## Definition of done
- A single `analyze_image` tool exists with a stable structured contract.
- The tool classifies before selecting a branch.
- Document/screenshot/general cases return structured observations rather than free-form captions by default.
- Ambiguous inputs escalate to `general_vlm` instead of pretending certainty.
- The routing logic is covered by focused golden tests.

## Progress
- [x] Confirm live proxy model inventory.
- [x] Confirm live rotussy model inventory.
- [x] Define `AnalyzeImageInput` and `StructuredObservation` contracts.
- [x] Define live v0 routing policy.
- [x] Define target v1 routing policy.
- [ ] Implement tool-layer router.
- [ ] Add golden tests.
- [ ] Harden fallback adapter for empty `content` / reasoning-only vision responses.

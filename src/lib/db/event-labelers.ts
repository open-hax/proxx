import { kernels } from "../cljs-kernels.js";
import type { EventInsert, EventLabeler } from "./event-store.js";

// Labeling rules live in proxx.events.labelers; each class is a handle on one
// labeler id that keeps the EventLabeler interface the store registers.
class KernelLabeler implements EventLabeler {
  public constructor(public readonly id: string) {}

  public applies(event: EventInsert): boolean {
    return kernels.eventLabelerApplies(this.id, event);
  }

  public label(event: EventInsert): string[] {
    return kernels.eventLabelerLabel(this.id, event);
  }
}

export class ErrorClassifierLabeler extends KernelLabeler {
  public constructor() {
    super("error_classifier");
  }
}

export class ToolUseLabeler extends KernelLabeler {
  public constructor() {
    super("tool_use");
  }
}

export class ContentPatternLabeler extends KernelLabeler {
  public constructor() {
    super("content_pattern");
  }
}

export class ResponseQualityLabeler extends KernelLabeler {
  public constructor() {
    super("response_quality");
  }
}

export class CostTierLabeler extends KernelLabeler {
  public constructor() {
    super("cost_tier");
  }
}

export function createDefaultLabelers(): EventLabeler[] {
  return [
    new ErrorClassifierLabeler(),
    new ToolUseLabeler(),
    new ContentPatternLabeler(),
    new ResponseQualityLabeler(),
    new CostTierLabeler(),
  ];
}

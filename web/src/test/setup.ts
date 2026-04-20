import "@testing-library/jest-dom/vitest";

// jsdom shims for component libs / charts.

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => {
    return {
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {
        // deprecated
      },
      removeListener: () => {
        // deprecated
      },
      addEventListener: () => {
        // noop
      },
      removeEventListener: () => {
        // noop
      },
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

class NoopResizeObserver {
  observe(): void {
    // noop
  }
  unobserve(): void {
    // noop
  }
  disconnect(): void {
    // noop
  }
}

if (!window.ResizeObserver) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ResizeObserver = NoopResizeObserver;
}

class NoopIntersectionObserver {
  public readonly root: Element | Document | null;
  public readonly rootMargin: string;
  public readonly thresholds: readonly number[];

  public constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _callback: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
  ) {
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    const threshold = options?.threshold;
    this.thresholds = Array.isArray(threshold) ? threshold : typeof threshold === "number" ? [threshold] : [0];
  }

  observe(): void {
    // noop
  }

  unobserve(): void {
    // noop
  }

  disconnect(): void {
    // noop
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

if (!window.IntersectionObserver) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).IntersectionObserver = NoopIntersectionObserver;
}

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App";

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return {
    ...original,
    getProxyUiSettings: vi.fn(async () => ({ fastMode: false })),
    saveProxyUiSettings: vi.fn(async (settings: unknown) => {
      if (typeof settings === "object" && settings !== null && "fastMode" in settings) {
        return { fastMode: Boolean((settings as { fastMode?: unknown }).fastMode) };
      }
      return { fastMode: false };
    }),
    listCredentials: vi.fn(async () => ({ providers: [], keyPoolStatuses: {}, requestLogSummary: {} })),
    getDisabledAccounts: vi.fn(async () => ({ disabledAccounts: [] })),
    listRequestLogs: vi.fn(async () => ([])),
    getOpenAiCredentialQuota: vi.fn(async () => ({ generatedAt: new Date().toISOString(), accounts: [] })),
    getOpenAiPromptCacheAudit: vi.fn(async () => ({ generatedAt: new Date().toISOString(), scannedEntryCount: 0, distinctHashCount: 0, crossAccountHashCount: 0, crossSuccessfulAccountHashCount: 0, rows: [] })),
  };
});

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = "";
  });

  it("renders without crashing (guards against missing LS_THEME / onboarding constants)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Proxx")).toBeInTheDocument();
    expect(screen.getByText("Proxy Token")).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
  });

  it("shows onboarding when no token is present and not onboarded", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Welcome to Proxx")).toBeInTheDocument();
  });

  it("renders credentials page without crashing (guards against missing refreshDisabledAccounts)", async () => {
    render(
      <MemoryRouter initialEntries={["/credentials"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Credentials Manager")).toBeInTheDocument();
  });
});

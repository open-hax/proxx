import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App";

vi.mock("../pages/DashboardPage", () => ({ DashboardPage: () => <div>Dashboard fixture</div> }));

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
  };
});

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = "";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200, ok: true, json: async () => ({ enabled: true, authenticated: false }),
    })));
  });

  it("renders without crashing (guards against missing LS_THEME / onboarding constants)", async () => {
    await act(async () => { render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    ); });

    expect(await screen.findByText("Proxx")).toBeInTheDocument();
    expect(screen.getByText("Proxy Token")).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
  });

  it("shows onboarding when no token is present and not onboarded", async () => {
    await act(async () => { render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    ); });

    expect(await screen.findByText("Welcome to Proxx")).toBeInTheDocument();
  });

  it("offers redirect SSO without putting an authority token in browser storage", async () => {
  await act(async () => { render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></MemoryRouter>); });
  const login = await screen.findByRole("link", { name: "Sign in with Axxium" });
  expect(login).toHaveAttribute("href", "/api/auth/axxium/start");
  expect(localStorage.getItem("open-hax-proxy.auth-token")).toBeNull();
});

  it("clears native browser credentials after shared login and reports product logout", async () => {
    localStorage.setItem("open-hax-proxy.auth-token", "synthetic-native-token");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ enabled: true, authenticated: true }) })
      .mockResolvedValueOnce({ status: 200, ok: true }));
    await act(async () => {
      render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></MemoryRouter>);
    });
    expect(localStorage.getItem("open-hax-proxy.auth-token")).toBeNull();
    expect(screen.queryByText("Welcome to Proxx")).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out of Proxx" })); });
    expect(await screen.findByText("Signed out of Proxx. Your Axxium root session remains on Axxium.")).toBeInTheDocument();
  });

});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountDeviceLogin } from "../../compiled/oidc/device.js";

let dispose: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren(); });
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows only the code and trusted link, polls its own backend at the interval, and completes", async () => {
  const complete = vi.fn();
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    calls.push(url);
    expect(options.credentials).toBe("same-origin");
    expect(options.method).toBe("POST");
    return { ok: true, json: async () => url.endsWith("/start")
      ? { user_code: "TEST-CODE", verification_uri: "https://authority.example/oidc/device", expires_in: 600, interval: 5 }
      : { status: url.endsWith("/poll") ? "complete" : "cancelled" } };
  }));
  const root = document.createElement("div"); document.body.append(root);
  dispose = mountDeviceLogin(root, complete);
  root.querySelector("button")!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(root.textContent).toContain("TEST-CODE");
  expect(root.querySelector("a")?.href).toBe("https://authority.example/oidc/device");
  expect(calls).toEqual(["/api/auth/axxium/device/start"]);
  await vi.advanceTimersByTimeAsync(4999);
  expect(complete).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(complete).toHaveBeenCalledOnce();
  expect(calls).toContain("/api/auth/axxium/device/poll");
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it("cancel fences pending UI completion and refuses an unsafe verification URI", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
    user_code: "TEST", verification_uri: "javascript:alert(1)", expires_in: 600, interval: 5,
  }) })));
  const root = document.createElement("div"); document.body.append(root);
  const complete = vi.fn(); dispose = mountDeviceLogin(root, complete);
  root.querySelector("button")!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(root.querySelector("a")).toBeNull();
  expect(root.textContent).toContain("unavailable");
  await vi.advanceTimersByTimeAsync(10000);
  expect(complete).not.toHaveBeenCalled();
});

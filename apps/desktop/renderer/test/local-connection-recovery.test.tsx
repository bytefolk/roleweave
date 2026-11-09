import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLocalConnectionRecovery } from "../src/turns/use-local-connection-recovery";
import type { TurnEngine } from "../src/turns/types";

const original = window.owb;
beforeEach(() => {
  vi.useFakeTimers();
  window.owb = { ...original, windowChrome: { platform: "win32", nativeControls: true },
    openQwenOffice: vi.fn().mockResolvedValue({ opened: true }) };
});
afterEach(() => { vi.useRealTimers(); window.owb = original; });

it.each(["qoder", "qwen-office-local"] as TurnEngine[])("refreshes %s after returning from its external client without overlapping checks", async engine => {
  let resolve!: () => void;
  const recheck = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  const { unmount } = renderHook(() => useLocalConnectionRecovery(engine, false, recheck));
  act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
  expect(recheck).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(); });
  act(() => window.dispatchEvent(new Event("focus")));
  expect(recheck).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(); });
  unmount();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(recheck).toHaveBeenCalledTimes(2);
});

it("polls a launched Office client until it is ready, then stops", async () => {
  const recheck = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ ready }) => useLocalConnectionRecovery("qwen-office-local", ready, recheck), { initialProps: { ready: false } });
  await act(async () => { await result.current.action?.onClick(); });
  expect(window.owb.openQwenOffice).toHaveBeenCalledTimes(1);
  expect(result.current.action?.busy).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(recheck).toHaveBeenCalledTimes(1);
  rerender({ ready: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(recheck).toHaveBeenCalledTimes(1);
  expect(result.current.action).toBeUndefined();
});

it("bounds startup polling and allows another attempt after failure", async () => {
  const recheck = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() => useLocalConnectionRecovery("qwen-office-local", false, recheck));
  await act(async () => { await result.current.action?.onClick(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
  expect(result.current.action?.busy).toBe(false);
  expect(result.current.feedback).toContain("尚未连接");
  const count = recheck.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
  expect(recheck).toHaveBeenCalledTimes(count);
});

it("ignores a late launch response after switching to Qoder", async () => {
  let resolve!: (value: { opened: boolean }) => void;
  window.owb.openQwenOffice = vi.fn(() => new Promise(done => { resolve = done; }));
  const recheck = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ engine }: { engine: TurnEngine }) => useLocalConnectionRecovery(engine, false, recheck), { initialProps: { engine: "qwen-office-local" } });
  act(() => { void result.current.action?.onClick(); });
  rerender({ engine: "qoder" });
  await act(async () => { resolve({ opened: true }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(recheck).not.toHaveBeenCalled();
  expect(result.current.action).toBeUndefined();
});

it("ends startup feedback at its deadline even when a health request is stalled", async () => {
  let resolve!: () => void;
  const recheck = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  const { result } = renderHook(() => useLocalConnectionRecovery("qwen-office-local", false, recheck));
  await act(async () => { await result.current.action?.onClick(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
  expect(result.current.action?.busy).toBe(false);
  expect(result.current.feedback).toContain("尚未连接");
  await act(async () => { resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
  expect(recheck).toHaveBeenCalledTimes(1);
});

it("reports a failed launch without polling or displaying native errors", async () => {
  window.owb.openQwenOffice = vi.fn().mockRejectedValue(Error("private path"));
  const recheck = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() => useLocalConnectionRecovery("qwen-office-local", false, recheck));
  await act(async () => { await result.current.action?.onClick(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(result.current.feedback).toContain("未能打开");
  expect(result.current.feedback).not.toContain("private path");
  expect(recheck).not.toHaveBeenCalled();
});

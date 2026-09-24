import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, sleep } from "#src/lib/process";

afterEach(() => {
  vi.useRealTimers();
});

describe("runCommand", () => {
  it("captures stdout from a successful command", async () => {
    const result = await runCommand({ cmd: "echo", args: ["hello"] });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr from a command that writes to stderr", async () => {
    const result = await runCommand({
      cmd: "sh",
      args: ["-c", "echo oops >&2"],
    });
    expect(result.stderr.trim()).toBe("oops");
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exit code without throwing", async () => {
    const result = await runCommand({ cmd: "sh", args: ["-c", "exit 42"] });
    expect(result.exitCode).toBe(42);
  });

  it("rejects when the command does not exist", async () => {
    await expect(
      runCommand({ cmd: "nonexistent-binary-abc123" }),
    ).rejects.toThrow();
  });

  it("respects the cwd option", async () => {
    const result = await runCommand({ cmd: "pwd", cwd: "/tmp" });
    // /tmp may resolve to /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });
});

describe("sleep", () => {
  it("resolves after the specified duration", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toThrow(/aborted/i);
  });

  it("rejects with AbortError when signal aborts mid-sleep", async () => {
    const controller = new AbortController();
    const p = sleep(1000, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it("resolves normally when no signal is provided (fake timers)", async () => {
    vi.useFakeTimers();
    const p = sleep(50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBeUndefined();
  });
});

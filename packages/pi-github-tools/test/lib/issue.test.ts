import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCommand = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/process", () => ({
  runCommand: mockRunCommand,
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { closeIssue } from "#src/lib/issue";

beforeEach(() => {
  mockRunCommand.mockReset();
});

function mockGh(stdout = "") {
  mockRunCommand.mockResolvedValueOnce({
    stdout,
    stderr: "",
    exitCode: 0,
  });
}

describe("closeIssue", () => {
  it("closes an issue with default reason", async () => {
    mockGh(); // gh issue close
    const result = await closeIssue({ issueNumber: 42 });
    expect(result).toContain("Closed issue #42");
    expect(result).toContain("completed");
  });

  it("closes an issue with a comment", async () => {
    mockGh();
    const result = await closeIssue({
      issueNumber: 42,
      comment: "Done!",
    });
    expect(result).toContain("Closed issue #42");
    // Verify the comment arg was passed
    const callArgs = mockRunCommand.mock.calls[0][0].args;
    expect(callArgs).toContain("--comment");
    expect(callArgs).toContain("Done!");
  });

  it("normalizes not_planned reason", async () => {
    mockGh();
    const result = await closeIssue({
      issueNumber: 42,
      reason: "not_planned",
    });
    expect(result).toContain("not_planned");
    // gh CLI expects "not planned" (with space)
    const callArgs = mockRunCommand.mock.calls[0][0].args;
    expect(callArgs).toContain("not planned");
  });

  it("rejects 'not planned' with space", async () => {
    await expect(
      closeIssue({ issueNumber: 42, reason: "not planned" }),
    ).rejects.toThrow(/not_planned/);
  });

  it("rejects invalid reason", async () => {
    await expect(
      closeIssue({ issueNumber: 42, reason: "invalid" }),
    ).rejects.toThrow(/Invalid reason/);
  });

  it("threads signal to gh call", async () => {
    mockGh();
    const controller = new AbortController();
    await closeIssue({ issueNumber: 42, signal: controller.signal });
    expect(mockRunCommand).toHaveBeenCalledWith({
      cmd: "gh",
      args: ["issue", "close", "42", "--reason", "completed"],
      signal: controller.signal,
    });
  });
});

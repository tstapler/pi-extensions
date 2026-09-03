import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  cloneSnapshot,
  createTask,
  emptySnapshot,
  formatTasks,
  isTaskSnapshot,
  replaceTasks,
  type TaskSnapshot,
  updateTask,
} from "./tasks.js";

const execFileAsync = promisify(execFile);
const TASK_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TodoWrite",
  "TodoRead",
]);
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_LINES = 200;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function taskResult(text: string, snapshot: TaskSnapshot) {
  return textResult(text, { taskSnapshot: cloneSnapshot(snapshot) });
}

function bounded(text: string): string {
  const lines = text.split("\n");
  const lineBounded = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  const byteLength = Buffer.byteLength(lineBounded);
  if (lines.length <= MAX_OUTPUT_LINES && byteLength <= MAX_OUTPUT_BYTES) {
    return lineBounded;
  }
  const bytes = Buffer.from(lineBounded).subarray(0, MAX_OUTPUT_BYTES);
  return `${bytes.toString("utf8")}\n[output truncated]`;
}

async function runRg(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("rg", args, {
      cwd,
      signal,
      maxBuffer: MAX_OUTPUT_BYTES * 4,
      encoding: "utf8",
    });
    return bounded(stdout || stderr || "No matches");
  } catch (error) {
    const failure = error as Error & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    if (failure.code === 1 && !failure.stderr) return "No matches";
    return bounded(
      failure.stderr || failure.stdout || `rg failed: ${failure.message}`,
    );
  }
}

const TaskStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);

export default function claudeCompat(pi: ExtensionAPI) {
  let snapshot = emptySnapshot();

  const reconstruct = (ctx: ExtensionContext) => {
    snapshot = emptySnapshot();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message as
        | { role?: string; toolName?: string; details?: unknown }
        | undefined;
      if (
        message?.role !== "toolResult" ||
        !message.toolName ||
        !TASK_TOOL_NAMES.has(message.toolName)
      ) {
        continue;
      }
      const details = message.details as { taskSnapshot?: unknown } | undefined;
      if (isTaskSnapshot(details?.taskSnapshot)) {
        snapshot = cloneSnapshot(details.taskSnapshot);
      }
    }
  };

  pi.on("session_start", (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask User Question",
    description:
      "Ask the user 1-4 structured questions. Never invent an answer when UI is unavailable.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String(),
          header: Type.String(),
          options: Type.Array(
            Type.Object({
              label: Type.String(),
              description: Type.String(),
            }),
            { minItems: 2, maxItems: 4 },
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        }),
        { minItems: 1, maxItems: 4 },
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (ctx.mode !== "tui") {
        return textResult(
          "Cannot ask the user in non-interactive mode. Stop and request the missing information in plain text.",
          { cancelled: true, answers: {} },
        );
      }

      const answers: Record<string, string | string[]> = {};
      for (const question of params.questions) {
        const displays = question.options.map(
          (option) => `${option.label} — ${option.description}`,
        );
        displays.push("Other — enter a custom answer");

        if (!question.multiSelect) {
          const selected = await ctx.ui.select(question.question, displays);
          if (selected === undefined) {
            return textResult("User cancelled the questionnaire.", {
              cancelled: true,
              answers,
            });
          }
          if (selected === displays.at(-1)) {
            const custom = await ctx.ui.input(question.question);
            if (custom === undefined) {
              return textResult("User cancelled the questionnaire.", {
                cancelled: true,
                answers,
              });
            }
            answers[question.header] = custom;
          } else {
            answers[question.header] =
              question.options[displays.indexOf(selected)]?.label ?? selected;
          }
          continue;
        }

        const remaining = [...displays];
        const selectedValues: string[] = [];
        while (remaining.length > 0) {
          const choice = await ctx.ui.select(question.question, [
            ...remaining,
            "Done selecting",
          ]);
          if (choice === undefined) {
            return textResult("User cancelled the questionnaire.", {
              cancelled: true,
              answers,
            });
          }
          if (choice === "Done selecting") break;
          remaining.splice(remaining.indexOf(choice), 1);
          if (choice === displays.at(-1)) {
            const custom = await ctx.ui.input(question.question);
            if (custom === undefined) {
              return textResult("User cancelled the questionnaire.", {
                cancelled: true,
                answers,
              });
            }
            selectedValues.push(custom);
          } else {
            selectedValues.push(
              question.options[displays.indexOf(choice)]?.label ?? choice,
            );
          }
        }
        answers[question.header] = selectedValues;
      }

      return textResult(JSON.stringify(answers), { cancelled: false, answers });
    },
  });

  pi.registerTool({
    name: "TaskCreate",
    label: "Task Create",
    description: "Create a persistent task and return its task ID.",
    parameters: Type.Object({
      subject: Type.String(),
      description: Type.String(),
      activeForm: Type.Optional(Type.String()),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, params) {
      const task = createTask(snapshot, params);
      return taskResult(`Created task #${task.id}: ${task.subject}`, snapshot);
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "Task Update",
    description: "Update status, text, dependencies, or metadata for one task.",
    parameters: Type.Object({
      taskId: Type.String(),
      subject: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      activeForm: Type.Optional(Type.String()),
      status: Type.Optional(TaskStatus),
      addBlocks: Type.Optional(Type.Array(Type.String())),
      addBlockedBy: Type.Optional(Type.Array(Type.String())),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, params) {
      const task = updateTask(snapshot, params.taskId, params);
      if (!task) return taskResult(`Task #${params.taskId} not found`, snapshot);
      return taskResult(`Updated task #${task.id}: ${task.subject}`, snapshot);
    },
  });

  pi.registerTool({
    name: "TaskList",
    label: "Task List",
    description: "List all tasks and their current status.",
    parameters: Type.Object({}),
    async execute() {
      return taskResult(formatTasks(snapshot.tasks), snapshot);
    },
  });

  pi.registerTool({
    name: "TaskGet",
    label: "Task Get",
    description: "Get one task by ID.",
    parameters: Type.Object({ taskId: Type.String() }),
    async execute(_id, params) {
      const task = snapshot.tasks.find((candidate) => candidate.id === params.taskId);
      return taskResult(
        task ? JSON.stringify(task, null, 2) : `Task #${params.taskId} not found`,
        snapshot,
      );
    },
  });

  pi.registerTool({
    name: "TodoWrite",
    label: "Todo Write",
    description: "Replace the canonical task list using Claude Code's todo schema.",
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String(),
          status: TaskStatus,
          activeForm: Type.Optional(Type.String()),
        }),
      ),
    }),
    async execute(_id, params) {
      replaceTasks(snapshot, params.todos);
      return taskResult(formatTasks(snapshot.tasks), snapshot);
    },
  });

  pi.registerTool({
    name: "TodoRead",
    label: "Todo Read",
    description: "Read the canonical task list using Claude Code's todo schema.",
    parameters: Type.Object({}),
    async execute() {
      const todos = snapshot.tasks.map((task) => ({
        content: task.subject,
        status: task.status,
        activeForm: task.activeForm,
      }));
      return taskResult(JSON.stringify(todos, null, 2), snapshot);
    },
  });

  pi.registerTool({
    name: "Grep",
    label: "Grep",
    description: "Claude-compatible ripgrep text search with bounded output.",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
      head_limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const args = ["--line-number", "--color=never", "--", params.pattern];
      if (params.glob) args.unshift("--glob", params.glob);
      args.push(params.path ?? ".");
      const output = await runRg(args, ctx.cwd, signal);
      const limit = Math.min(params.head_limit ?? MAX_OUTPUT_LINES, MAX_OUTPUT_LINES);
      return textResult(output.split("\n").slice(0, limit).join("\n"));
    },
  });

  pi.registerTool({
    name: "Glob",
    label: "Glob",
    description: "Claude-compatible file glob using ripgrep's file index.",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const args = ["--files", "--glob", params.pattern, params.path ?? "."];
      return textResult(await runRg(args, ctx.cwd, signal));
    },
  });

  pi.registerTool({
    name: "LS",
    label: "List Directory",
    description: "Claude-compatible directory listing with bounded output.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const directory = resolve(ctx.cwd, params.path ?? ".");
        const entries = await readdir(directory, { withFileTypes: true });
        const output = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
          .join("\n");
        return textResult(bounded(output));
      } catch (error) {
        return textResult(`LS failed: ${(error as Error).message}`);
      }
    },
  });
}

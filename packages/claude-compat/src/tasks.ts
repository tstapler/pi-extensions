export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskSnapshot {
  version: 1;
  nextId: number;
  tasks: Task[];
}

export function emptySnapshot(): TaskSnapshot {
  return { version: 1, nextId: 1, tasks: [] };
}

export function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return structuredClone(snapshot);
}

export function createTask(
  snapshot: TaskSnapshot,
  input: Pick<Task, "subject" | "description"> &
    Partial<Pick<Task, "activeForm" | "metadata">>,
): Task {
  const task: Task = {
    id: String(snapshot.nextId++),
    subject: input.subject,
    description: input.description,
    activeForm: input.activeForm,
    status: "pending",
    blocks: [],
    blockedBy: [],
    metadata: input.metadata,
  };
  snapshot.tasks.push(task);
  return task;
}

export interface TaskPatch {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  addBlocks?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, unknown>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function updateTask(
  snapshot: TaskSnapshot,
  taskId: string,
  patch: TaskPatch,
): Task | undefined {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return undefined;

  if (patch.subject !== undefined) task.subject = patch.subject;
  if (patch.description !== undefined) task.description = patch.description;
  if (patch.activeForm !== undefined) task.activeForm = patch.activeForm;
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.metadata !== undefined) task.metadata = patch.metadata;
  if (patch.addBlocks) task.blocks = unique([...task.blocks, ...patch.addBlocks]);
  if (patch.addBlockedBy) {
    task.blockedBy = unique([...task.blockedBy, ...patch.addBlockedBy]);
  }
  return task;
}

export function replaceTasks(
  snapshot: TaskSnapshot,
  items: Array<{ content: string; status: TaskStatus; activeForm?: string }>,
): void {
  snapshot.tasks = items.map((item, index) => ({
    id: String(index + 1),
    subject: item.content,
    description: item.content,
    activeForm: item.activeForm,
    status: item.status,
    blocks: [],
    blockedBy: [],
  }));
  snapshot.nextId = snapshot.tasks.length + 1;
}

export function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TaskSnapshot>;
  return (
    candidate.version === 1 &&
    Number.isInteger(candidate.nextId) &&
    Array.isArray(candidate.tasks)
  );
}

export function formatTasks(tasks: Task[]): string {
  if (tasks.length === 0) return "No tasks";
  return tasks
    .map((task) => {
      const marker =
        task.status === "completed"
          ? "x"
          : task.status === "in_progress"
            ? ">"
            : " ";
      const dependencies = task.blockedBy.length
        ? ` (blocked by ${task.blockedBy.join(", ")})`
        : "";
      return `[${marker}] #${task.id} ${task.subject}${dependencies}`;
    })
    .join("\n");
}

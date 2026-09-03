import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneSnapshot,
  createTask,
  emptySnapshot,
  formatTasks,
  isTaskSnapshot,
  replaceTasks,
  updateTask,
} from "../src/tasks.js";

test("creates and updates tasks without splitting canonical state", () => {
  const snapshot = emptySnapshot();
  const first = createTask(snapshot, {
    subject: "Research",
    description: "Inspect candidate extensions",
  });
  const second = createTask(snapshot, {
    subject: "Implement",
    description: "Build the selected profile",
  });

  updateTask(snapshot, first.id, {
    status: "completed",
    addBlocks: [second.id, second.id],
  });
  updateTask(snapshot, second.id, {
    status: "in_progress",
    addBlockedBy: [first.id],
  });

  assert.equal(snapshot.nextId, 3);
  assert.deepEqual(snapshot.tasks[0]?.blocks, ["2"]);
  assert.deepEqual(snapshot.tasks[1]?.blockedBy, ["1"]);
  assert.match(formatTasks(snapshot.tasks), /\[x\] #1 Research/);
  assert.match(formatTasks(snapshot.tasks), /\[>\] #2 Implement \(blocked by 1\)/);
});

test("TodoWrite replacement uses the same task store", () => {
  const snapshot = emptySnapshot();
  createTask(snapshot, { subject: "Old", description: "Old" });
  replaceTasks(snapshot, [
    { content: "First", status: "completed", activeForm: "Completing first" },
    { content: "Second", status: "pending" },
  ]);

  assert.deepEqual(
    snapshot.tasks.map(({ id, subject, status }) => ({ id, subject, status })),
    [
      { id: "1", subject: "First", status: "completed" },
      { id: "2", subject: "Second", status: "pending" },
    ],
  );
  assert.equal(snapshot.nextId, 3);
});

test("snapshots clone deeply and reject malformed state", () => {
  const snapshot = emptySnapshot();
  createTask(snapshot, { subject: "One", description: "One" });
  const clone = cloneSnapshot(snapshot);
  clone.tasks[0]!.subject = "Changed";

  assert.equal(snapshot.tasks[0]?.subject, "One");
  assert.equal(isTaskSnapshot(snapshot), true);
  assert.equal(isTaskSnapshot({ version: 1, nextId: "2", tasks: [] }), false);
  assert.equal(isTaskSnapshot(null), false);
});

import fs from "node:fs/promises";
import path from "node:path";
import { lock, unlock } from "proper-lockfile";
import type {
  Message,
  MessageType,
  Task,
  TaskStatus,
  SessionStatus,
} from "../utils/types.js";
import {
  TASKS_DIR,
  MESSAGES_DIR,
  SESSIONS_DIR,
  SESSION_STATUS_FILE,
} from "../utils/constants.js";

// ============================================================
// Environment helpers
// ============================================================

function getOrchestratorDir(): string {
  const dir = process.env.ORCHESTRATOR_DIR;
  if (!dir) {
    throw new Error("ORCHESTRATOR_DIR environment variable is not set");
  }
  return dir;
}

function getSessionId(): string {
  const id = process.env.SESSION_ID;
  if (!id) {
    throw new Error("SESSION_ID environment variable is not set");
  }
  return id;
}

function tasksDir(): string {
  return path.join(getOrchestratorDir(), TASKS_DIR);
}

function messagesDir(): string {
  return path.join(getOrchestratorDir(), MESSAGES_DIR);
}

function sessionsDir(): string {
  return path.join(getOrchestratorDir(), SESSIONS_DIR);
}

// ============================================================
// Utility helpers
// ============================================================

/**
 * Ensure a directory exists, creating it and parents if necessary.
 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Generate a unique message ID: {SESSION_ID}-{timestamp}-{random4chars}
 */
function generateMessageId(): string {
  const sessionId = getSessionId();
  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  return `${sessionId}-${timestamp}-${rand}`;
}

/**
 * Safely read a JSON file. Returns null if the file doesn't exist.
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Safely read a JSONL file. Returns empty array if the file doesn't exist.
 */
async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as T);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

// ============================================================
// Tool: read_updates
// ============================================================

export interface ReadUpdatesInput {
  since?: string;
}

export async function handleReadUpdates(
  input: ReadUpdatesInput
): Promise<Message[]> {
  const dir = messagesDir();
  await ensureDir(dir);

  const sessionId = getSessionId();
  const sinceTs = input.since ? new Date(input.since).getTime() : 0;

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  const allMessages: Message[] = [];

  for (const file of jsonlFiles) {
    const filePath = path.join(dir, file);
    const messages = await readJsonlFile<Message>(filePath);
    allMessages.push(...messages);
  }

  // Filter: include messages addressed to this session or broadcasts (no `to` field)
  const filtered = allMessages.filter((msg) => {
    // Must be newer than `since`
    const msgTs = new Date(msg.timestamp).getTime();
    if (msgTs <= sinceTs) return false;

    // Must be addressed to us or be a broadcast
    if (msg.to && msg.to !== sessionId) return false;

    return true;
  });

  // Sort by timestamp ascending
  filtered.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return filtered;
}

// ============================================================
// Tool: post_update
// ============================================================

export interface PostUpdateInput {
  type: MessageType;
  content: string;
  to?: string;
}

export async function handlePostUpdate(
  input: PostUpdateInput
): Promise<Message> {
  const dir = messagesDir();
  await ensureDir(dir);

  const sessionId = getSessionId();
  const message: Message = {
    id: generateMessageId(),
    from: sessionId,
    type: input.type,
    content: input.content,
    timestamp: new Date().toISOString(),
  };

  if (input.to) {
    message.to = input.to;
  }

  const filePath = path.join(dir, `${sessionId}.jsonl`);
  await fs.appendFile(filePath, JSON.stringify(message) + "\n", "utf-8");

  return message;
}

// ============================================================
// Tool: get_tasks
// ============================================================

export interface GetTasksInput {
  status_filter?: TaskStatus;
}

export async function handleGetTasks(input: GetTasksInput): Promise<Task[]> {
  const dir = tasksDir();
  await ensureDir(dir);

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const tasks: Task[] = [];

  for (const file of jsonFiles) {
    const filePath = path.join(dir, file);
    const task = await readJsonFile<Task>(filePath);
    if (task) {
      if (!input.status_filter || task.status === input.status_filter) {
        tasks.push(task);
      }
    }
  }

  // Sort by id
  tasks.sort((a, b) => a.id.localeCompare(b.id));

  return tasks;
}

// ============================================================
// Tool: claim_task
// ============================================================

export interface ClaimTaskInput {
  task_id: string;
}

export interface ClaimTaskResult {
  success: boolean;
  task?: Task;
  error?: string;
}

export async function handleClaimTask(
  input: ClaimTaskInput
): Promise<ClaimTaskResult> {
  const dir = tasksDir();
  await ensureDir(dir);

  const taskPath = path.join(dir, `${input.task_id}.json`);

  // Verify the file exists before trying to lock
  try {
    await fs.access(taskPath);
  } catch {
    return { success: false, error: `Task file not found: ${input.task_id}` };
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(taskPath, { retries: { retries: 3, minTimeout: 100 } });

    const task = await readJsonFile<Task>(taskPath);
    if (!task) {
      return { success: false, error: `Task not found: ${input.task_id}` };
    }

    // Verify task is pending
    if (task.status !== "pending") {
      return {
        success: false,
        error: `Task ${input.task_id} is not pending (current status: ${task.status})`,
      };
    }

    // Verify all dependencies are completed
    if (task.depends_on.length > 0) {
      for (const depId of task.depends_on) {
        const depPath = path.join(dir, `${depId}.json`);
        const depTask = await readJsonFile<Task>(depPath);
        if (!depTask || depTask.status !== "completed") {
          return {
            success: false,
            error: `Task ${input.task_id} is blocked by unresolved dependency: ${depId}`,
          };
        }
      }
    }

    // Claim the task
    const sessionId = getSessionId();
    task.status = "in_progress";
    task.owner = sessionId;
    task.started_at = new Date().toISOString();

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");

    return { success: true, task };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during claim";
    return { success: false, error: message };
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Lock may already be released if the process is dying
      }
    }
  }
}

// ============================================================
// Tool: complete_task
// ============================================================

export interface CompleteTaskInput {
  task_id: string;
  result_summary: string;
  files_changed?: string[];
}

export interface CompleteTaskResult {
  success: boolean;
  task?: Task;
  error?: string;
}

export async function handleCompleteTask(
  input: CompleteTaskInput
): Promise<CompleteTaskResult> {
  const dir = tasksDir();
  await ensureDir(dir);

  const taskPath = path.join(dir, `${input.task_id}.json`);

  // Verify the file exists before trying to lock
  try {
    await fs.access(taskPath);
  } catch {
    return { success: false, error: `Task file not found: ${input.task_id}` };
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(taskPath, { retries: { retries: 3, minTimeout: 100 } });

    const task = await readJsonFile<Task>(taskPath);
    if (!task) {
      return { success: false, error: `Task not found: ${input.task_id}` };
    }

    // Verify this session owns the task
    const sessionId = getSessionId();
    if (task.owner !== sessionId) {
      return {
        success: false,
        error: `Task ${input.task_id} is owned by ${task.owner}, not ${sessionId}`,
      };
    }

    // Mark as completed
    task.status = "completed";
    task.completed_at = new Date().toISOString();
    task.result_summary = input.result_summary;
    if (input.files_changed) {
      task.files_changed = input.files_changed;
    }

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");

    // Post a task_completed message to the orchestrator message log
    const msgDir = messagesDir();
    await ensureDir(msgDir);

    const completionMessage: Message = {
      id: generateMessageId(),
      from: sessionId,
      type: "task_completed",
      to: "orchestrator",
      content: `Task ${input.task_id} completed: ${input.result_summary}`,
      metadata: {
        task_id: input.task_id,
        files_changed: input.files_changed ?? [],
      },
      timestamp: new Date().toISOString(),
    };

    const msgPath = path.join(msgDir, `${sessionId}.jsonl`);
    await fs.appendFile(
      msgPath,
      JSON.stringify(completionMessage) + "\n",
      "utf-8"
    );

    return { success: true, task };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during completion";
    return { success: false, error: message };
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Lock may already be released
      }
    }
  }
}

// ============================================================
// Tool: get_session_status
// ============================================================

export interface GetSessionStatusInput {
  session_id: string;
}

export interface GetSessionStatusResult {
  found: boolean;
  status?: SessionStatus;
}

export async function handleGetSessionStatus(
  input: GetSessionStatusInput
): Promise<GetSessionStatusResult> {
  const dir = sessionsDir();
  const statusPath = path.join(dir, input.session_id, SESSION_STATUS_FILE);

  const status = await readJsonFile<SessionStatus>(statusPath);
  if (!status) {
    return { found: false };
  }

  return { found: true, status };
}

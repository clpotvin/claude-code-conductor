#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  handleReadUpdates,
  handlePostUpdate,
  handleGetTasks,
  handleClaimTask,
  handleCompleteTask,
  handleGetSessionStatus,
} from "./tools.js";

// ============================================================
// Validate required environment variables
// ============================================================

function validateEnv(): void {
  if (!process.env.ORCHESTRATOR_DIR) {
    console.error(
      "Fatal: ORCHESTRATOR_DIR environment variable is required"
    );
    process.exit(1);
  }
  if (!process.env.SESSION_ID) {
    console.error("Fatal: SESSION_ID environment variable is required");
    process.exit(1);
  }
}

// ============================================================
// MCP Server setup
// ============================================================

async function main(): Promise<void> {
  validateEnv();

  const server = new McpServer(
    {
      name: "coordination-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ----------------------------------------------------------
  // Tool: read_updates
  // ----------------------------------------------------------
  server.tool(
    "read_updates",
    "Read messages from the orchestrator and other sessions. Returns messages addressed to this session or broadcast messages. Optionally filter by timestamp.",
    {
      since: z.string().optional().describe(
        "ISO 8601 timestamp. Only return messages newer than this. If omitted, returns all messages."
      ),
    },
    async (args) => {
      const messages = await handleReadUpdates({ since: args.since });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(messages, null, 2),
          },
        ],
      };
    }
  );

  // ----------------------------------------------------------
  // Tool: post_update
  // ----------------------------------------------------------
  server.tool(
    "post_update",
    "Post a status update, question, or result to the shared message log. The 'from' field is automatically set to this session's ID.",
    {
      type: z.enum([
        "status",
        "question",
        "answer",
        "broadcast",
        "wind_down",
        "task_completed",
        "error",
        "escalation",
      ]).describe("The type of message to post"),
      content: z.string().describe("The message content"),
      to: z.string().optional().describe(
        "Target session ID. Omit for broadcast messages."
      ),
    },
    async (args) => {
      const message = await handlePostUpdate({
        type: args.type,
        content: args.content,
        to: args.to,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(message, null, 2),
          },
        ],
      };
    }
  );

  // ----------------------------------------------------------
  // Tool: get_tasks
  // ----------------------------------------------------------
  server.tool(
    "get_tasks",
    "List all tasks with their current status. Optionally filter by task status.",
    {
      status_filter: z.enum(["pending", "in_progress", "completed", "failed"])
        .optional()
        .describe("Filter tasks by status. If omitted, returns all tasks."),
    },
    async (args) => {
      const tasks = await handleGetTasks({
        status_filter: args.status_filter,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(tasks, null, 2),
          },
        ],
      };
    }
  );

  // ----------------------------------------------------------
  // Tool: claim_task
  // ----------------------------------------------------------
  server.tool(
    "claim_task",
    "Atomically claim an unclaimed, unblocked task. The task must be 'pending' and all of its dependencies must be 'completed'. On success, the task status is set to 'in_progress' and assigned to this session.",
    {
      task_id: z.string().describe("The ID of the task to claim"),
    },
    async (args) => {
      const result = await handleClaimTask({ task_id: args.task_id });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: !result.success,
      };
    }
  );

  // ----------------------------------------------------------
  // Tool: complete_task
  // ----------------------------------------------------------
  server.tool(
    "complete_task",
    "Mark a task as completed with a result summary. Only the session that owns (claimed) the task can complete it. Also posts a task_completed message to the orchestrator.",
    {
      task_id: z.string().describe("The ID of the task to complete"),
      result_summary: z.string().describe(
        "Summary of what was accomplished for this task"
      ),
      files_changed: z.array(z.string()).optional().describe(
        "List of file paths that were created or modified"
      ),
    },
    async (args) => {
      const result = await handleCompleteTask({
        task_id: args.task_id,
        result_summary: args.result_summary,
        files_changed: args.files_changed,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: !result.success,
      };
    }
  );

  // ----------------------------------------------------------
  // Tool: get_session_status
  // ----------------------------------------------------------
  server.tool(
    "get_session_status",
    "Check the current status of another worker session. Returns session state, current task, and progress information.",
    {
      session_id: z.string().describe("The session ID to look up"),
    },
    async (args) => {
      const result = await handleGetSessionStatus({
        session_id: args.session_id,
      });

      if (!result.found) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "unknown", session_id: args.session_id }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.status, null, 2),
          },
        ],
      };
    }
  );

  // ----------------------------------------------------------
  // Connect via stdio transport
  // ----------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run
main().catch((err) => {
  console.error("Coordination server fatal error:", err);
  process.exit(1);
});

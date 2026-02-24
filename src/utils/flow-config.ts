import fs from "node:fs/promises";
import path from "node:path";

import type { FlowConfig } from "./types.js";
import { ORCHESTRATOR_DIR } from "./constants.js";

// ============================================================
// Default (generic) flow configuration
// ============================================================

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  layers: [
    {
      name: "Frontend/UI Layer",
      checks: [
        "What data does the component send? What response does it expect?",
        "Does it handle error states, loading states, empty states?",
        "Are there role-based UI guards that match the backend permissions?",
      ],
    },
    {
      name: "API/Route Layer",
      checks: [
        "Does the endpoint enforce authentication and authorization?",
        "Does it validate input with a schema?",
        "Does it sanitize error responses (no raw DB errors leaked)?",
        "Does the response format match what the frontend expects?",
      ],
    },
    {
      name: "Service/Business Logic Layer",
      checks: [
        "Does it correctly scope queries to the current user/organization?",
        "Are there race conditions with concurrent callers?",
        "Does it handle partial failures and rollback correctly?",
      ],
    },
    {
      name: "Database/Persistence Layer",
      checks: [
        "Can this specific actor type perform the operation? (SELECT/INSERT/UPDATE/DELETE)",
        "Are access control policies correctly applied for each actor?",
        "Are there FK constraints with proper cascade behavior?",
        "Would a constraint violation occur during multi-step operations?",
      ],
    },
    {
      name: "Cross-Boundary Verification",
      checks: [
        "If the API assumes a row exists, does the access policy allow reading it?",
        "If the frontend sends a token, does the backend validate it for this actor?",
        "If a background job is required, does it actually exist?",
        "Do assumptions about data shape match across all layers?",
      ],
    },
  ],

  actor_types: [
    "owner",
    "admin",
    "member",
    "viewer",
    "anonymous",
    "unauthenticated",
    "service_account",
  ],

  edge_cases: [
    "Empty/missing environment variables at runtime",
    "Pagination boundary (>100 items, >1000 items)",
    "Concurrent modifications (two users acting simultaneously)",
    "Token/session expiry mid-flow",
    "Access policy mismatch between layers (API assumes access, DB denies)",
    "Constraint ordering (unique index violation during multi-step update)",
    "Anonymous/unauthenticated user hitting authenticated endpoints",
    "First-time user who hasn't completed onboarding",
    "User with revoked/changed role mid-session",
    "Network failure between service boundaries",
  ],

  example_flows: [
    {
      id: "user-signup",
      name: "New user signs up",
      description:
        "A new user creates an account, which provisions default resources and sends a welcome email.",
      entry_points: ["app/signup/page.tsx", "app/api/auth/signup/route.ts"],
      actors: ["unauthenticated", "anonymous"],
      edge_cases: [
        "Email already taken",
        "Weak password",
        "Signup while already authenticated",
      ],
    },
    {
      id: "invite-member",
      name: "Invite a new member to an organization",
      description:
        "An admin invites a user by email, which creates an invitation record and sends an email. The invited user clicks the link to accept.",
      entry_points: [
        "app/settings/members/page.tsx",
        "app/api/invitations/route.ts",
      ],
      actors: ["admin", "member", "unauthenticated"],
      edge_cases: [
        "User already a member",
        "Invitation token expired",
        "Invitation already accepted",
      ],
    },
    {
      id: "delete-resource",
      name: "Delete a shared resource",
      description:
        "A user deletes a resource that may be referenced by other entities, triggering cascading updates.",
      entry_points: [
        "app/resources/[id]/page.tsx",
        "app/api/resources/[id]/route.ts",
      ],
      actors: ["owner", "admin", "member", "viewer"],
      edge_cases: [
        "Resource referenced by other entities",
        "Concurrent edit during deletion",
        "Viewer attempting deletion",
      ],
    },
  ],
};

// ============================================================
// Loader
// ============================================================

const FLOW_CONFIG_FILENAME = "flow-config.json";

/**
 * Load flow configuration from `.orchestrator/flow-config.json` in the
 * project directory. Falls back to DEFAULT_FLOW_CONFIG when the file
 * does not exist.
 *
 * User config replaces defaults entirely per top-level key (no deep merge).
 */
export async function loadFlowConfig(projectDir: string): Promise<FlowConfig> {
  const configPath = path.join(projectDir, ORCHESTRATOR_DIR, FLOW_CONFIG_FILENAME);

  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FlowConfig>;

    // Validate required fields, warn on missing
    const requiredKeys: (keyof FlowConfig)[] = [
      "layers",
      "actor_types",
      "edge_cases",
      "example_flows",
    ];
    for (const key of requiredKeys) {
      if (!(key in parsed)) {
        console.warn(
          `[flow-config] Warning: "${key}" missing from ${configPath}, using default.`,
        );
      }
    }

    // Shallow merge: user-provided keys override defaults entirely
    return {
      layers: parsed.layers ?? DEFAULT_FLOW_CONFIG.layers,
      actor_types: parsed.actor_types ?? DEFAULT_FLOW_CONFIG.actor_types,
      edge_cases: parsed.edge_cases ?? DEFAULT_FLOW_CONFIG.edge_cases,
      example_flows: parsed.example_flows ?? DEFAULT_FLOW_CONFIG.example_flows,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No config file — use defaults silently
      return DEFAULT_FLOW_CONFIG;
    }
    console.warn(
      `[flow-config] Failed to load ${configPath}: ${err instanceof Error ? err.message : String(err)}. Using defaults.`,
    );
    return DEFAULT_FLOW_CONFIG;
  }
}

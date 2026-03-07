/**
 * Unit tests for Project Detector Module.
 *
 * These tests use temp directories with real file system operations
 * to verify detection logic for various project types.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  detectProject,
  loadCachedProfile,
  cacheProfile,
  detectProjectWithCache,
  formatProjectGuidance,
} from "./project-detector.js";
import type { ProjectProfile } from "../utils/types.js";

// ============================================================
// Test Helpers
// ============================================================

let tempDir: string;

async function createFile(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(tempDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

async function createPackageJson(
  deps: Record<string, string> = {},
  devDeps: Record<string, string> = {}
): Promise<void> {
  await createFile(
    "package.json",
    JSON.stringify({
      name: "test-project",
      dependencies: deps,
      devDependencies: devDeps,
    })
  );
}

// ============================================================
// Setup / Teardown
// ============================================================

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-detect-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ============================================================
// Language Detection Tests
// ============================================================

describe("detectProject - Language Detection", () => {
  it("detects TypeScript from tsconfig.json", async () => {
    await createFile("tsconfig.json", "{}");
    await createPackageJson();

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
  });

  it("detects TypeScript from package.json dependency", async () => {
    await createPackageJson({}, { typescript: "^5.0.0" });

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
  });

  it("detects JavaScript when no TypeScript present", async () => {
    await createPackageJson({ express: "^4.18.0" });

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("javascript");
    expect(profile.languages).not.toContain("typescript");
  });

  it("detects Python from pyproject.toml", async () => {
    await createFile("pyproject.toml", '[project]\nname = "test"');

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
  });

  it("detects Python from requirements.txt", async () => {
    await createFile("requirements.txt", "flask>=2.0.0\nrequests>=2.28.0");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
  });

  it("detects Python from Pipfile", async () => {
    await createFile("Pipfile", "[packages]\nflask = '*'");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
  });

  it("detects Python from setup.py", async () => {
    await createFile("setup.py", "from setuptools import setup\nsetup()");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
  });

  it("detects multiple languages", async () => {
    await createFile("tsconfig.json", "{}");
    await createPackageJson();
    await createFile("pyproject.toml", '[project]\nname = "test"');

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
    expect(profile.languages).toContain("python");
  });

  it("returns empty languages for empty project", async () => {
    const profile = await detectProject(tempDir);

    expect(profile.languages).toEqual([]);
  });
});

// ============================================================
// Framework Detection Tests
// ============================================================

describe("detectProject - Framework Detection", () => {
  it.each([
    ["next", "nextjs"],
    ["express", "express"],
    ["@nestjs/core", "nestjs"],
    ["react", "react"],
    ["vue", "vue"],
    ["@angular/core", "angular"],
    ["svelte", "svelte"],
    ["fastify", "fastify"],
  ] as const)(
    "detects Node.js framework %s as %s",
    async (dep, expected) => {
      // Some frameworks need tsconfig for TS detection (nestjs, angular, fastify use TS typically)
      // but the source only requires the language to be detected - package.json is enough for JS
      await createPackageJson({ [dep]: "^1.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain(expected);
    }
  );

  it.each([
    ["fastapi", "fastapi"],
    ["django", "django"],
    ["flask", "flask"],
  ] as const)(
    "detects Python framework %s from pyproject.toml",
    async (dep, expected) => {
      await createFile(
        "pyproject.toml",
        `[project]\nname = "test"\ndependencies = ["${dep}>=1.0.0"]`
      );

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain(expected);
    }
  );

  it("detects FastAPI from requirements.txt", async () => {
    await createFile("requirements.txt", "fastapi>=0.100.0\nuvicorn>=0.23.0");

    const profile = await detectProject(tempDir);

    expect(profile.frameworks).toContain("fastapi");
  });

  it("detects Django from requirements.txt", async () => {
    await createFile("requirements.txt", "Django>=4.0\npsycopg2>=2.9");

    const profile = await detectProject(tempDir);

    expect(profile.frameworks).toContain("django");
  });
});

// ============================================================
// Test Runner Detection Tests
// ============================================================

describe("detectProject - Test Runner Detection", () => {
  it.each([
    ["vitest", "vitest"],
    ["jest", "jest"],
    ["mocha", "mocha"],
  ] as const)(
    "detects %s from package.json",
    async (dep, expected) => {
      await createPackageJson({}, { [dep]: "^1.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.test_runners).toContain(expected);
    }
  );

  it("detects pytest from pyproject.toml", async () => {
    await createFile(
      "pyproject.toml",
      `[project]\ndependencies = ["pytest>=7.0.0"]`
    );

    const profile = await detectProject(tempDir);

    expect(profile.test_runners).toContain("pytest");
  });

  it("detects pytest from pytest.ini", async () => {
    await createFile("pytest.ini", "[pytest]\ntestpaths = tests");

    const profile = await detectProject(tempDir);

    expect(profile.test_runners).toContain("pytest");
  });

  it("detects pytest from requirements.txt", async () => {
    await createFile("requirements.txt", "pytest>=7.0\npytest-cov>=4.0");

    const profile = await detectProject(tempDir);

    expect(profile.test_runners).toContain("pytest");
  });
});

// ============================================================
// Linter Detection Tests
// ============================================================

describe("detectProject - Linter Detection", () => {
  it.each([
    ["eslint", "eslint"],
    ["prettier", "prettier"],
    ["@biomejs/biome", "biome"],
  ] as const)(
    "detects %s from package.json",
    async (dep, expected) => {
      await createPackageJson({}, { [dep]: "^1.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain(expected);
    }
  );

  it.each([
    [".eslintrc.json", "eslint"],
    ["eslint.config.js", "eslint"],
    [".prettierrc", "prettier"],
    ["biome.json", "biome"],
    ["ruff.toml", "ruff"],
    [".ruff.toml", "ruff"],
    ["mypy.ini", "mypy"],
  ] as const)(
    "detects %s from config file %s",
    async (file, expected) => {
      // Some config files need package.json to exist for the linter check path
      await createFile(file, "{}");

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain(expected);
    }
  );

  it.each([
    ["[tool.ruff]\nline-length = 120", "ruff"],
    ["[tool.black]\nline-length = 100", "black"],
    ["[tool.mypy]\npython_version = \"3.11\"", "mypy"],
    ["[tool.isort]\nprofile = \"black\"", "isort"],
  ] as const)(
    "detects %s from pyproject.toml tool section",
    async (content, expected) => {
      await createFile("pyproject.toml", content);

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain(expected);
    }
  );
});

// ============================================================
// CI System Detection Tests
// ============================================================

describe("detectProject - CI System Detection", () => {
  it.each([
    [".github/workflows/ci.yml", "github-actions"],
    [".gitlab-ci.yml", "gitlab-ci"],
    [".circleci/config.yml", "circleci"],
    [".travis.yml", "travis-ci"],
    ["Jenkinsfile", "jenkins"],
    ["azure-pipelines.yml", "azure-pipelines"],
  ] as const)(
    "detects %s from %s",
    async (file, expected) => {
      await createFile(file, "content");

      const profile = await detectProject(tempDir);

      expect(profile.ci_systems).toContain(expected);
    }
  );
});

// ============================================================
// Package Manager Detection Tests
// ============================================================

describe("detectProject - Package Manager Detection", () => {
  it.each([
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lockb", "bun"],
  ] as const)(
    "detects Node.js package manager from %s",
    async (lockFile, expected) => {
      await createPackageJson();
      await createFile(lockFile, "");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain(expected);
    }
  );

  it.each([
    ["requirements.txt", "pip"],
    ["Pipfile", "pipenv"],
    ["poetry.lock", "poetry"],
    ["pdm.lock", "pdm"],
    ["uv.lock", "uv"],
  ] as const)(
    "detects Python package manager from %s",
    async (lockFile, expected) => {
      await createFile(lockFile, "");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain(expected);
    }
  );
});

// ============================================================
// Edge Case Tests
// ============================================================

describe("detectProject - Edge Cases", () => {
  it("handles malformed package.json without crashing", async () => {
    await createFile("package.json", "{invalid json");

    const profile = await detectProject(tempDir);

    // Should return a profile (readJsonSafe returns null on parse error)
    expect(profile).toBeDefined();
    expect(profile.frameworks).toEqual([]);
  });

  it("handles package.json with wrong dependency types without crashing", async () => {
    await createFile(
      "package.json",
      JSON.stringify({ dependencies: "not-an-object", devDependencies: 42 })
    );

    const profile = await detectProject(tempDir);

    expect(profile).toBeDefined();
    expect(profile.frameworks).toEqual([]);
  });

  it("detects Django case-insensitively from requirements.txt", async () => {
    // The source does .toLowerCase() on requirements.txt lines
    await createFile("requirements.txt", "Django>=4.0");

    const profile = await detectProject(tempDir);

    expect(profile.frameworks).toContain("django");
  });
});

// ============================================================
// Caching Tests
// ============================================================

describe("Caching Functions", () => {
  it("cacheProfile writes profile to disk", async () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: ["typescript"],
      frameworks: ["express"],
      test_runners: ["vitest"],
      linters: ["eslint"],
      ci_systems: ["github-actions"],
      package_managers: ["npm"],
    };

    await cacheProfile(tempDir, profile);

    const cached = await loadCachedProfile(tempDir);
    expect(cached).toEqual(profile);
  });

  it("loadCachedProfile returns null for missing file", async () => {
    const cached = await loadCachedProfile(tempDir);
    expect(cached).toBeNull();
  });

  it("detectProjectWithCache uses cache when available", async () => {
    const cachedProfile: ProjectProfile = {
      detected_at: "2020-01-01T00:00:00.000Z",
      languages: ["typescript"],
      frameworks: ["cached-framework"],
      test_runners: [],
      linters: [],
      ci_systems: [],
      package_managers: [],
    };
    await cacheProfile(tempDir, cachedProfile);

    await createPackageJson({ express: "^4.0.0" });

    const profile = await detectProjectWithCache(tempDir);

    expect(profile.frameworks).toContain("cached-framework");
    expect(profile.detected_at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("detectProjectWithCache refreshes when forceRefresh is true", async () => {
    const cachedProfile: ProjectProfile = {
      detected_at: "2020-01-01T00:00:00.000Z",
      languages: [],
      frameworks: ["old-framework"],
      test_runners: [],
      linters: [],
      ci_systems: [],
      package_managers: [],
    };
    await cacheProfile(tempDir, cachedProfile);

    await createPackageJson({ express: "^4.0.0" });

    const profile = await detectProjectWithCache(tempDir, true);

    expect(profile.frameworks).toContain("express");
    expect(profile.frameworks).not.toContain("old-framework");
    expect(profile.detected_at).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("detectProjectWithCache caches result after detection", async () => {
    await createPackageJson({ express: "^4.0.0" });

    await detectProjectWithCache(tempDir);

    const cached = await loadCachedProfile(tempDir);
    expect(cached).not.toBeNull();
    expect(cached?.frameworks).toContain("express");
  });
});

// ============================================================
// formatProjectGuidance Tests
// ============================================================

describe("formatProjectGuidance", () => {
  it("produces valid markdown with all detected features", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: ["typescript", "javascript"],
      frameworks: ["nextjs", "react"],
      test_runners: ["vitest"],
      linters: ["eslint", "prettier"],
      ci_systems: ["github-actions"],
      package_managers: ["npm"],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("## Project Profile");
    expect(guidance).toContain("typescript");
    expect(guidance).toContain("nextjs");
    expect(guidance).toContain("vitest");
    expect(guidance).toContain("eslint");
    expect(guidance).toContain("github-actions");
    expect(guidance).toContain("npm");
  });

  it("handles empty profile gracefully", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: [],
      frameworks: [],
      test_runners: [],
      linters: [],
      ci_systems: [],
      package_managers: [],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("## Project Profile");
    expect(typeof guidance).toBe("string");
  });

  it("includes Useful Commands section", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: ["typescript"],
      frameworks: [],
      test_runners: ["vitest"],
      linters: ["eslint"],
      ci_systems: [],
      package_managers: ["npm"],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("### Useful Commands");
    expect(guidance).toContain("npm install");
    expect(guidance).toContain("npx vitest run");
    expect(guidance).toContain("npx eslint");
    expect(guidance).toContain("npx tsc --noEmit");
  });
});

// ============================================================
// Full Detection Integration Tests
// ============================================================

describe("Full Project Detection", () => {
  it("detects complete TypeScript/Node.js project", async () => {
    await createFile("tsconfig.json", "{}");
    await createPackageJson(
      { express: "^4.18.0" },
      { typescript: "^5.0.0", vitest: "^2.0.0", eslint: "^8.0.0" }
    );
    await createFile("package-lock.json", "{}");
    await createFile(".github/workflows/ci.yml", "on: push");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
    expect(profile.frameworks).toContain("express");
    expect(profile.test_runners).toContain("vitest");
    expect(profile.linters).toContain("eslint");
    expect(profile.ci_systems).toContain("github-actions");
    expect(profile.package_managers).toContain("npm");
    expect(profile.detected_at).toBeDefined();
  });

  it("detects complete Python/FastAPI project", async () => {
    await createFile(
      "pyproject.toml",
      `[project]
name = "myapi"
dependencies = ["fastapi>=0.100.0"]

[tool.ruff]
line-length = 100

[tool.pytest.ini_options]
testpaths = ["tests"]`
    );
    await createFile("poetry.lock", "");
    await createFile(".github/workflows/ci.yml", "on: push");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
    expect(profile.frameworks).toContain("fastapi");
    expect(profile.test_runners).toContain("pytest");
    expect(profile.linters).toContain("ruff");
    expect(profile.ci_systems).toContain("github-actions");
    expect(profile.package_managers).toContain("poetry");
  });

  it("handles mixed TypeScript + Python monorepo", async () => {
    await createFile("tsconfig.json", "{}");
    await createPackageJson({ next: "^14.0.0" }, { vitest: "^2.0.0" });
    await createFile("pnpm-lock.yaml", "");

    await createFile("pyproject.toml", '[project]\nname="service"');
    await createFile("requirements.txt", "fastapi>=0.100.0\npytest>=7.0");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
    expect(profile.languages).toContain("python");
    expect(profile.frameworks).toContain("nextjs");
    expect(profile.frameworks).toContain("fastapi");
    expect(profile.test_runners).toContain("vitest");
    expect(profile.test_runners).toContain("pytest");
    expect(profile.package_managers).toContain("pnpm");
    expect(profile.package_managers).toContain("pip");
  });
});

/**
 * Hooks Adapter — Platform-specific hook configuration
 *
 * Translates universal hook definitions to platform-specific formats
 * for Claude, Cursor, Windsurf, and other AI agents.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HookInstallConfig } from "../types/index.js";

const home = homedir();

// ── Hook Adapter Interface ────────────────────────────────────────────────────

export interface HookAdapter {
  /** Agent name */
  readonly name: string;
  /** Translate hook to platform-specific format */
  translateHook(hookConfig: HookInstallConfig): string;
  /** Get the path to the hooks directory */
  getHookPath(hookType: string, global: boolean): string;
  /** Get the filename for the hook */
  getHookFileName(hookName: string): string;
}

// ── Universal Hook Format ─────────────────────────────────────────────────────

/**
 * Parse hook from universal markdown format
 */
export interface ParsedHook {
  name: string;
  type: "SessionStart" | "SessionEnd" | "PreToolUse" | "PostToolUse";
  priority: number;
  platforms: string[];
  content: string;
}

/**
 * Parse a hook file in the universal markdown format
 */
export function parseHookFile(content: string): ParsedHook {
  const frontmatterMatch = content.match(/^<!--\s*\n([\s\S]*?)\n-->/);
  if (!frontmatterMatch) {
    throw new Error("Invalid hook format: missing frontmatter");
  }

  const frontmatter = frontmatterMatch[1];
  const metadata: Record<string, unknown> = {};

  // Simple YAML parser for hook metadata
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      if (key === "platforms") {
        metadata[key] = (value as string).split(",").map((s) => s.trim());
      } else if (key === "priority") {
        metadata[key] = Number.parseInt(value, 10);
      } else {
        metadata[key] = value;
      }
    }
  }

  const body = content.replace(/^<!--\s*\n[\s\S]*?\n-->/, "").trim();

  return {
    name: metadata.name as string,
    type: metadata.type as ParsedHook["type"],
    priority: (metadata.priority as number) || 100,
    platforms: (metadata.platforms as string[]) || ["*"],
    content: body,
  };
}

// ── Claude Hook Adapter ───────────────────────────────────────────────────────

export class ClaudeHookAdapter implements HookAdapter {
  readonly name = "claude";

  getHookFileName(hookName: string): string {
    return `${hookName}.md`;
  }

  getHookPath(hookType: string, global: boolean): string {
    const base = global ? join(home, ".claude", "hooks") : join(".claude", "hooks");
    return join(base, hookType.toLowerCase());
  }

  translateHook(hookConfig: HookInstallConfig): string {
    // Claude uses markdown files with YAML frontmatter
    return `<!--
name: ${hookConfig.name}
type: ${hookConfig.type}
priority: ${hookConfig.priority || 100}
-->

${hookConfig.script}
`;
  }
}

// ── Cursor Hook Adapter ───────────────────────────────────────────────────────

export class CursorHookAdapter implements HookAdapter {
  readonly name = "cursor";

  getHookFileName(hookName: string): string {
    return `${hookName}.md`;
  }

  getHookPath(hookType: string, global: boolean): string {
    const base = global ? join(home, ".cursor", "hooks") : join(".cursor", "hooks");
    return join(base, hookType.toLowerCase());
  }

  translateHook(hookConfig: HookInstallConfig): string {
    // Cursor uses similar format to Claude
    return `<!--
name: ${hookConfig.name}
type: ${hookConfig.type}
priority: ${hookConfig.priority || 100}
-->

${hookConfig.script}
`;
  }
}

// ── Windsurf Hook Adapter ────────────────────────────────────────────────────

export class WindsurfHookAdapter implements HookAdapter {
  readonly name = "windsurf";

  getHookFileName(hookName: string): string {
    return `${hookName}.md`;
  }

  getHookPath(hookType: string, global: boolean): string {
    const base = global ? join(home, ".codeium", "windsurf", "hooks") : join(".windsurf", "hooks");
    return join(base, hookType.toLowerCase());
  }

  translateHook(hookConfig: HookInstallConfig): string {
    // Windsurf uses markdown format
    return `<!--
name: ${hookConfig.name}
type: ${hookConfig.type}
priority: ${hookConfig.priority || 100}
-->

${hookConfig.script}
`;
  }
}

// ── Universal Hook Adapter ───────────────────────────────────────────────────

export class UniversalHookAdapter implements HookAdapter {
  readonly name: string;
  readonly projectDir: string;
  readonly globalDir: string;

  constructor(name: string, projectDir: string, globalDir: string) {
    this.name = name;
    this.projectDir = projectDir;
    this.globalDir = globalDir;
  }

  getHookFileName(hookName: string): string {
    return `${hookName}.md`;
  }

  getHookPath(hookType: string, global: boolean): string {
    const base = global ? this.globalDir : this.projectDir;
    // Navigate to parent and add hooks directory
    return join(dirname(base), "hooks", hookType.toLowerCase());
  }

  translateHook(hookConfig: HookInstallConfig): string {
    // Standard universal format
    return `<!--
name: ${hookConfig.name}
type: ${hookConfig.type}
priority: ${hookConfig.priority || 100}
-->

${hookConfig.script}
`;
  }
}

// ── Hook Adapter Factory ─────────────────────────────────────────────────────

/**
 * Get a hook adapter for a given agent name
 */
export function getHookAdapter(agentName: string): HookAdapter {
  switch (agentName) {
    case "claude":
      return new ClaudeHookAdapter();
    case "cursor":
      return new CursorHookAdapter();
    case "windsurf":
      return new WindsurfHookAdapter();
    default:
      return new UniversalHookAdapter(
        agentName,
        `.${agentName}/skills`,
        `${home}/.${agentName}/skills`,
      );
  }
}

// ── Hook Registry ────────────────────────────────────────────────────────────

/**
 * Get all installed hooks for a specific agent and type
 */
export function getInstalledHooks(
  agentName: string,
  hookType: string,
  global: boolean,
): ParsedHook[] {
  const adapter = getHookAdapter(agentName);
  const hookPath = adapter.getHookPath(hookType, global);
  const hooks: ParsedHook[] = [];

  if (!existsSync(hookPath)) {
    return hooks;
  }

  // Read all .md files in the hook directory
  const { readdirSync } = require("node:fs");
  const files = readdirSync(hookPath);

  for (const file of files) {
    if (file.endsWith(".md")) {
      try {
        const content = readFileSync(join(hookPath, file), "utf-8");
        hooks.push(parseHookFile(content));
      } catch {
        // Skip invalid hooks
      }
    }
  }

  // Sort by priority
  hooks.sort((a, b) => a.priority - b.priority);

  return hooks;
}

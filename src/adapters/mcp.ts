/**
 * MCP Adapter — Platform-specific MCP server configuration
 *
 * Translates unified MCP configuration to platform-specific formats
 * for Claude, Cursor, Copilot, and other AI agents.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MCPInstallConfig } from "../types/index.js";

const home = homedir();

// ── MCP Adapter Interface ────────────────────────────────────────────────────

export interface MCPAdapter {
  /** Agent name */
  readonly name: string;
  /** Generate platform-specific MCP configuration */
  generatePlatformConfig(mcpConfig: MCPInstallConfig): string | Record<string, unknown>;
  /** Get the path to the MCP configuration file */
  getMCPConfigPath(global: boolean): string;
  /** Get the MCP config file name */
  getConfigFileName(): string;
}

// ── Claude MCP Adapter ────────────────────────────────────────────────────────

export class ClaudeMCPAdapter implements MCPAdapter {
  readonly name = "claude";

  getConfigFileName(): string {
    return "mcp.json";
  }

  getMCPConfigPath(global: boolean): string {
    return global
      ? join(home, ".claude", this.getConfigFileName())
      : join(".claude", this.getConfigFileName());
  }

  generatePlatformConfig(mcpConfig: MCPInstallConfig): string {
    // Claude expects individual mcp.json files or a combined format
    // For simplicity, generate a single MCP server config
    return JSON.stringify(
      {
        mcpServers: {
          [mcpConfig.name]: {
            command: mcpConfig.command,
            args: mcpConfig.args,
            env: mcpConfig.env || {},
          },
        },
      },
      null,
      2,
    );
  }
}

// ── Cursor MCP Adapter ───────────────────────────────────────────────────────

export class CursorMCPAdapter implements MCPAdapter {
  readonly name = "cursor";

  getConfigFileName(): string {
    return "mcp.json";
  }

  getMCPConfigPath(global: boolean): string {
    return global
      ? join(home, ".cursor", this.getConfigFileName())
      : join(".cursor", this.getConfigFileName());
  }

  generatePlatformConfig(mcpConfig: MCPInstallConfig): string {
    // Cursor format similar to Claude
    return JSON.stringify(
      {
        mcpServers: {
          [mcpConfig.name]: {
            command: mcpConfig.command,
            args: mcpConfig.args,
            env: mcpConfig.env || {},
          },
        },
      },
      null,
      2,
    );
  }
}

// ── Copilot MCP Adapter ──────────────────────────────────────────────────────

export class CopilotMCPAdapter implements MCPAdapter {
  readonly name = "copilot";

  getConfigFileName(): string {
    return "mcp.json";
  }

  getMCPConfigPath(global: boolean): string {
    return global
      ? join(home, ".github", "copilot", this.getConfigFileName())
      : join(".github", "copilot", this.getConfigFileName());
  }

  generatePlatformConfig(mcpConfig: MCPInstallConfig): string {
    // Copilot format
    return JSON.stringify(
      {
        mcpServers: {
          [mcpConfig.name]: {
            command: mcpConfig.command,
            args: mcpConfig.args,
            env: mcpConfig.env || {},
          },
        },
      },
      null,
      2,
    );
  }
}

// ── Universal MCP Adapter ─────────────────────────────────────────────────────

export class UniversalMCPAdapter implements MCPAdapter {
  readonly name: string;
  readonly projectDir: string;
  readonly globalDir: string;

  constructor(name: string, projectDir: string, globalDir: string) {
    this.name = name;
    this.projectDir = projectDir;
    this.globalDir = globalDir;
  }

  getConfigFileName(): string {
    return "mcp.json";
  }

  getMCPConfigPath(global: boolean): string {
    const base = global ? this.globalDir : this.projectDir;
    // Navigate to parent and add mcp.json
    return join(dirname(base), this.getConfigFileName());
  }

  generatePlatformConfig(mcpConfig: MCPInstallConfig): string {
    // Standard format for unknown platforms
    return JSON.stringify(
      {
        mcpServers: {
          [mcpConfig.name]: {
            command: mcpConfig.command,
            args: mcpConfig.args,
            env: mcpConfig.env || {},
          },
        },
      },
      null,
      2,
    );
  }
}

// ── MCP Adapter Factory ──────────────────────────────────────────────────────

/**
 * Get an MCP adapter for a given agent name
 */
export function getMCPAdapter(agentName: string): MCPAdapter {
  switch (agentName) {
    case "claude":
      return new ClaudeMCPAdapter();
    case "cursor":
      return new CursorMCPAdapter();
    case "copilot":
      return new CopilotMCPAdapter();
    default:
      return new UniversalMCPAdapter(
        agentName,
        `.${agentName}/skills`,
        `${home}/.${agentName}/skills`,
      );
  }
}

// ── MCP Config Merger ────────────────────────────────────────────────────────

/**
 * Merge multiple MCP configurations into a single file
 */
export async function mergeMCPConfigs(
  agentName: string,
  configs: Array<{ name: string; config: MCPInstallConfig }>,
  global: boolean,
): Promise<void> {
  const adapter = getMCPAdapter(agentName);
  const configPath = adapter.getMCPConfigPath(global);

  // Read existing config if present
  let existingConfig: Record<string, unknown> = { mcpServers: {} };
  if (existsSync(configPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      existingConfig = require(configPath);
    } catch {
      // Invalid JSON, start fresh
    }
  }

  // Merge new configs
  const mcpServers = (existingConfig.mcpServers as Record<string, unknown>) || {};
  for (const { name, config } of configs) {
    mcpServers[name] = {
      command: config.command,
      args: config.args,
      env: config.env || {},
    };
  }

  // Ensure directory exists
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write merged config
  writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), "utf-8");
}

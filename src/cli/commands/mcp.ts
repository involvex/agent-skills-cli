/**
 * MCP Commands — Install, list, and remove MCP servers
 *
 * Supports:
 * - Official MCP registry
 * - Git repositories (GitHub, GitLab, etc.)
 * - Local configurations
 * - Interactive mode
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { getMCPAdapter, mergeMCPConfigs } from "../../adapters/mcp.js";
import { type ConfigRegistry, fetchConfigs, searchConfigs } from "../../core/config-fetcher.js";
import { installComponentWithSymlinks, removeComponentInstallation } from "../../core/installer.js";
import { parseSource } from "../../core/source-parser.js";
import { ComponentType, type MCPInstallConfig } from "../../types/index.js";
import { AGENTS, type AgentConfig } from "../agents.js";

/** Get available MCP servers from registries */
async function getAvailableMCPServers(): Promise<
  Array<{ name: string; description: string; source: string }>
> {
  const configs = await fetchConfigs({ type: ComponentType.MCP });
  return configs.map((c) => ({
    name: c.name,
    description: (c.metadata?.description as string) || "",
    source: c.source,
  }));
}

/** List MCP servers */
async function listMCPServers(options: {
  installed?: boolean;
  available?: boolean;
}): Promise<void> {
  if (options.available || (!options.installed && !options.available)) {
    const spinner = ora("Fetching available MCP servers...").start();
    try {
      const servers = await getAvailableMCPServers();
      spinner.stop();

      if (servers.length === 0) {
        console.log(chalk.yellow("No MCP servers found in registries."));
        return;
      }

      console.log(chalk.bold(`\n📦 Available MCP Servers (${servers.length}):\n`));
      for (const server of servers) {
        console.log(`  ${chalk.cyan(server.name)}`);
        if (server.description) {
          console.log(`    ${chalk.dim(server.description)}`);
        }
      }
      console.log("");
    } catch (err: unknown) {
      spinner.fail("Failed to fetch MCP servers");
      console.error(chalk.red((err as Error).message));
    }
  }

  if (options.installed) {
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    const configPath = join(homedir(), ".claude", "mcp.json");

    if (!existsSync(configPath)) {
      console.log(chalk.yellow("No MCP servers installed."));
      return;
    }

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const servers = config.mcpServers || {};

    console.log(chalk.bold(`\n📦 Installed MCP Servers (${Object.keys(servers).length}):\n`));
    for (const [name, serverConfig] of Object.entries(servers)) {
      console.log(`  ${chalk.green(name)}`);
      const cfg = serverConfig as MCPInstallConfig;
      console.log(`    Command: ${cfg.command} ${cfg.args.join(" ")}`);
    }
    console.log("");
  }
}

/** Install an MCP server */
async function installMCPServer(
  source: string,
  options: {
    global?: boolean;
    agent?: string[];
    all?: boolean;
    yes?: boolean;
  },
): Promise<void> {
  const { mkdir, cp, rm, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execSync } = await import("node:child_process");

  // Determine target agents
  let agents: string[] = options.agent || [];

  if (options.all) {
    agents = Object.keys(AGENTS);
  }

  if (agents.length === 0) {
    const agentChoices = Object.entries(AGENTS).map(([key, config]: [string, AgentConfig]) => ({
      label: config.displayName,
      value: key,
      hint: config.projectDir,
    }));

    const selected = await p.multiselect({
      message: "Install MCP server to which agents?",
      options: agentChoices,
      initialValues: ["claude", "cursor"],
      required: true,
    });

    if (p.isCancel(selected)) {
      p.cancel("Installation cancelled");
      return;
    }
    agents = selected as string[];
  }

  let mcpConfig: MCPInstallConfig | null = null;
  let tempDir: string | null = null;

  try {
    // Check if source is a well-known name
    const availableServers = await getAvailableMCPServers();
    const namedServer = availableServers.find((s) => s.name === source);

    if (namedServer) {
      // Fetch from registry
      const config = await searchConfigs(source, { type: ComponentType.MCP });
      if (config.length > 0) {
        const content = config[0].content;
        if (content.startsWith("{")) {
          mcpConfig = JSON.parse(content) as MCPInstallConfig;
        } else {
          // Parse from markdown frontmatter
          const match = content.match(/---\n([\s\S]*?)\n---/);
          if (match) {
            const yaml = match[1];
            const lines = yaml.split("\n");
            const parsed: Record<string, unknown> = {};
            for (const line of lines) {
              const m = line.match(/^(\w+):\s*(.+)$/);
              if (m) {
                const [, key, value] = m;
                parsed[key] = value;
              }
            }
            mcpConfig = {
              name: parsed.name as string,
              command: (parsed.command as string) || "npx",
              args: ((parsed.args as string) || "").split(" "),
              env: (parsed.env as Record<string, string>) || {},
            };
          }
        }
      }
    } else {
      // Parse as Git URL or local path
      const parsed = parseSource(source);

      if (parsed.type === "local") {
        // Read local config
        const configPath = join(parsed.localPath!, "mcp.json");
        if (existsSync(configPath)) {
          const { readFileSync } = await import("node:fs");
          mcpConfig = JSON.parse(readFileSync(configPath, "utf-8")) as MCPInstallConfig;
        } else {
          throw new Error(`mcp.json not found in ${parsed.localPath}`);
        }
      } else {
        // Clone Git repository
        tempDir = join(tmpdir(), `mcp-install-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });

        const spinner = ora(`Cloning ${source}...`).start();
        try {
          execSync(`git clone --depth 1 ${source} ${tempDir}`, {
            stdio: "pipe",
          });
          spinner.succeed("Repository cloned");
        } catch {
          spinner.fail("Failed to clone repository");
          throw new Error(`Failed to clone ${source}`);
        }

        const configPath = join(tempDir, "mcp.json");
        if (existsSync(configPath)) {
          const { readFileSync } = await import("node:fs");
          mcpConfig = JSON.parse(readFileSync(configPath, "utf-8")) as MCPInstallConfig;
        } else {
          throw new Error("mcp.json not found in repository");
        }
      }
    }

    if (!mcpConfig) {
      throw new Error("Could not parse MCP configuration");
    }

    // Install to agents
    console.log(chalk.bold(`\n📦 Installing MCP server: ${mcpConfig.name}\n`));

    for (const agentName of agents) {
      const spinner = ora(`Installing to ${AGENTS[agentName].displayName}...`).start();
      try {
        const adapter = getMCPAdapter(agentName);
        const configPath = adapter.getMCPConfigPath(!!options.global);

        // Merge with existing config
        await mergeMCPConfigs(
          agentName,
          [{ name: mcpConfig.name, config: mcpConfig }],
          !!options.global,
        );

        spinner.succeed(`${AGENTS[agentName].displayName}`);
      } catch (err: unknown) {
        spinner.fail(`${AGENTS[agentName].displayName}: ${(err as Error).message}`);
      }
    }

    console.log(chalk.bold.green(`\n✨ MCP server installed successfully\n`));
  } finally {
    // Cleanup temp directory
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Remove an MCP server */
async function removeMCPServer(
  name: string,
  options: { global?: boolean; agent?: string[] },
): Promise<void> {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  const agents = options.agent || ["claude"];

  for (const agentName of agents) {
    const adapter = getMCPAdapter(agentName);
    const configPath = adapter.getMCPConfigPath(!!options.global);

    if (!existsSync(configPath)) {
      console.log(chalk.yellow(`No MCP config found for ${agentName}`));
      continue;
    }

    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    if (!config.mcpServers || !config.mcpServers[name]) {
      console.log(chalk.yellow(`MCP server "${name}" not found in ${agentName}`));
      continue;
    }

    delete config.mcpServers[name];

    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    console.log(chalk.green(`✓ Removed "${name}" from ${agentName}`));
  }

  console.log("");
}

/** Register MCP commands */
export function registerMCPCommands(program: Command): void {
  const mcpCmd = program.command("mcp").description("MCP server management");

  // Install command
  mcpCmd
    .command("install <source>")
    .description("Install an MCP server from registry, Git URL, or local path")
    .option("-g, --global", "Install globally")
    .option("-a, --agent <agents...>", "Target specific agents")
    .option("--all", "Install to all agents")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(installMCPServer);

  // List command
  mcpCmd
    .command("list")
    .description("List MCP servers")
    .option("--installed", "List installed servers")
    .option("--available", "List available servers from registries")
    .action(listMCPServers);

  // Remove command
  mcpCmd
    .command("remove <name>")
    .description("Remove an installed MCP server")
    .option("-g, --global", "Remove from global config")
    .option("-a, --agent <agents...>", "Target specific agents")
    .action(removeMCPServer);
}

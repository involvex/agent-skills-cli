/**
 * Agent Commands — Install, list, and remove agent configurations
 *
 * Supports:
 * - Official agent registry
 * - Git repositories
 * - Local configurations
 * - Interactive mode
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { fetchConfigs, searchConfigs } from "../../core/config-fetcher.js";
import { installComponentWithSymlinks, removeComponentInstallation } from "../../core/installer.js";
import { parseSource } from "../../core/source-parser.js";
import { ComponentType } from "../../types/index.js";
import { AGENTS, type AgentConfig } from "../agents.js";

/** Get available agent configs from registries */
async function getAvailableAgentConfigs(): Promise<
  Array<{ name: string; description: string; source: string }>
> {
  const configs = await fetchConfigs({ type: ComponentType.AGENT });
  return configs.map((c) => ({
    name: c.name,
    description: (c.metadata?.description as string) || "",
    source: c.source,
  }));
}

/** List agent configurations */
async function listAgentConfigs(options: {
  installed?: boolean;
  available?: boolean;
}): Promise<void> {
  if (options.available || (!options.installed && !options.available)) {
    const spinner = ora("Fetching available agent configurations...").start();
    try {
      const configs = await getAvailableAgentConfigs();
      spinner.stop();

      if (configs.length === 0) {
        console.log(chalk.yellow("No agent configurations found in registries."));
        return;
      }

      console.log(chalk.bold(`\n📦 Available Agent Configurations (${configs.length}):\n`));
      for (const config of configs) {
        console.log(`  ${chalk.cyan(config.name)}`);
        if (config.description) {
          console.log(`    ${chalk.dim(config.description)}`);
        }
      }
      console.log("");
    } catch (err: unknown) {
      spinner.fail("Failed to fetch agent configurations");
      console.error(chalk.red((err as Error).message));
    }
  }

  if (options.installed) {
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    const agentDir = join(homedir(), ".agent", "agents");

    if (!existsSync(agentDir)) {
      console.log(chalk.yellow("No agent configurations installed."));
      return;
    }

    const dirs = readdirSync(agentDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    console.log(chalk.bold(`\n📦 Installed Agent Configurations (${dirs.length}):\n`));
    for (const name of dirs) {
      const configPath = join(agentDir, name, "config.json");
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, "utf-8"));
          console.log(`  ${chalk.green(name)}`);
          if (config.description) {
            console.log(`    ${chalk.dim(config.description)}`);
          }
          if (config.executable) {
            console.log(`    Executable: ${config.executable}`);
          }
        } catch {
          console.log(`  ${chalk.green(name)}`);
        }
      } else {
        console.log(`  ${chalk.yellow(name)} (invalid)`);
      }
    }
    console.log("");
  }
}

/** Install an agent configuration */
async function installAgentConfig(
  source: string,
  options: {
    global?: boolean;
    agent?: string[];
    all?: boolean;
  },
): Promise<void> {
  const { mkdir, cp, rm, writeFile } = await import("node:fs/promises");
  const { existsSync: fsExistsSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execSync } = await import("node:child_process");

  // Local reference for existsSync
  const existsSync = fsExistsSync;

  // Determine target platforms (where to install this agent config)
  // By default, agent configs go to the .agent/agents/ directory
  const isGlobal = options.global ?? true;

  let configData: Record<string, unknown> | null = null;
  let configName: string | null = null;
  let tempDir: string | null = null;

  try {
    // Check if source is a well-known name
    const availableConfigs = await getAvailableAgentConfigs();
    const namedConfig = availableConfigs.find((c) => c.name === source);

    if (namedConfig) {
      // Fetch from registry
      const config = await searchConfigs(source, { type: ComponentType.AGENT });
      if (config.length > 0) {
        const content = config[0].content;
        if (content.startsWith("{")) {
          configData = JSON.parse(content);
          configName = (configData as { name: string }).name as string;
        } else {
          // Parse from markdown frontmatter
          const match = content.match(/---\n([\s\S]*?)\n---/);
          if (match) {
            const yaml = match[1];
            const lines = yaml.split("\n");
            for (const line of lines) {
              const m = line.match(/^(\w+):\s*(.+)$/);
              if (m) {
                const [, key, value] = m;
                if (key === "name") configName = value;
                if (!configData) configData = {};
                (configData as Record<string, unknown>)[key] = value;
              }
            }
          }
        }
      }
    } else {
      // Parse as Git URL or local path
      const parsed = parseSource(source);

      if (parsed.type === "local") {
        // Read local config
        const localConfigPath = join(parsed.localPath!, "config.json");
        if (existsSync(localConfigPath)) {
          const { readFileSync } = await import("node:fs");
          configData = JSON.parse(readFileSync(localConfigPath, "utf-8"));
          configName = (configData as { name: string }).name as string;
        } else {
          throw new Error(`config.json not found in ${parsed.localPath}`);
        }
      } else {
        // Clone Git repository
        tempDir = join(tmpdir(), `agent-install-${Date.now()}`);
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

        const configPath = join(tempDir, "config.json");
        if (existsSync(configPath)) {
          const { readFileSync } = await import("node:fs");
          configData = JSON.parse(readFileSync(configPath, "utf-8"));
          configName = (configData as { name: string }).name as string;
        } else {
          throw new Error("config.json not found in repository");
        }
      }
    }

    if (!configData || !configName) {
      throw new Error("Could not parse agent configuration");
    }

    // Install to .agent/agents/ directory
    console.log(chalk.bold(`\n📦 Installing agent configuration: ${configName}\n`));

    const canonicalDir = join(
      isGlobal ? process.env.HOME || "~" : process.cwd(),
      ".agent",
      "agents",
    );
    const targetDir = join(canonicalDir, configName);

    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "config.json"), JSON.stringify(configData, null, 2), "utf-8");

    console.log(chalk.green(`✓ Installed to ${targetDir}`));
    console.log(chalk.bold.green(`\n✨ Agent configuration installed successfully\n`));
  } finally {
    // Cleanup temp directory
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Remove an agent configuration */
async function removeAgentConfig(name: string, options: { global?: boolean }): Promise<void> {
  const { existsSync: fsExistsSync } = await import("node:fs");
  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  const isGlobal = options.global ?? true;
  const canonicalDir = join(isGlobal ? homedir() : process.cwd(), ".agent", "agents");
  const targetDir = join(canonicalDir, name);

  if (!fsExistsSync(targetDir)) {
    console.log(chalk.yellow(`Agent configuration "${name}" not found`));
    return;
  }

  await rm(targetDir, { recursive: true, force: true });
  console.log(chalk.green(`✓ Removed "${name}"`));
  console.log("");
}

/** Register agent commands */
export function registerAgentCommands(program: Command): void {
  const agentCmd = program.command("agent").description("Agent configuration management");

  // Install command
  agentCmd
    .command("install <source>")
    .description("Install an agent configuration from registry, Git URL, or local path")
    .option("-g, --global", "Install globally (default)")
    .action(installAgentConfig);

  // List command
  agentCmd
    .command("list")
    .description("List agent configurations")
    .option("--installed", "List installed configurations")
    .option("--available", "List available configurations from registries")
    .action(listAgentConfigs);

  // Remove command
  agentCmd
    .command("remove <name>")
    .description("Remove an installed agent configuration")
    .option("-g, --global", "Remove from global config (default)")
    .action(removeAgentConfig);
}

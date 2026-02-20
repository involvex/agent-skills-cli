/**
 * Hooks Commands — Install, list, and remove lifecycle hooks
 *
 * Supports:
 * - Official hooks registry
 * - Git repositories
 * - Local hook files
 * - Interactive mode
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { getHookAdapter, parseHookFile } from "../../adapters/hooks.js";
import { fetchConfigs, searchConfigs } from "../../core/config-fetcher.js";
import { installComponentWithSymlinks, removeComponentInstallation } from "../../core/installer.js";
import { parseSource } from "../../core/source-parser.js";
import { ComponentType, type HookInstallConfig } from "../../types/index.js";
import { AGENTS, type AgentConfig } from "../agents.js";

/** Get available hooks from registries */
async function getAvailableHooks(): Promise<
  Array<{ name: string; description: string; type: string; source: string }>
> {
  const configs = await fetchConfigs({ type: ComponentType.HOOK });
  return configs.map((c) => ({
    name: c.name,
    description: (c.metadata?.description as string) || "",
    type: (c.metadata?.type as string) || "SessionStart",
    source: c.source,
  }));
}

/** List hooks */
async function listHooks(options: {
  installed?: boolean;
  available?: boolean;
  type?: string;
}): Promise<void> {
  if (options.available || (!options.installed && !options.available)) {
    const spinner = ora("Fetching available hooks...").start();
    try {
      const hooks = await getAvailableHooks();
      spinner.stop();

      const filtered = options.type
        ? hooks.filter((h) => h.type.toLowerCase() === options.type?.toLowerCase())
        : hooks;

      if (filtered.length === 0) {
        console.log(chalk.yellow("No hooks found in registries."));
        return;
      }

      console.log(chalk.bold(`\n📦 Available Hooks (${filtered.length}):\n`));
      for (const hook of filtered) {
        console.log(`  ${chalk.cyan(hook.name)} ${chalk.dim(`[${hook.type}]`)}`);
        if (hook.description) {
          console.log(`    ${chalk.dim(hook.description)}`);
        }
      }
      console.log("");
    } catch (err: unknown) {
      spinner.fail("Failed to fetch hooks");
      console.error(chalk.red((err as Error).message));
    }
  }

  if (options.installed) {
    const { existsSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    const hookTypes = ["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse"];

    for (const type of hookTypes) {
      if (options.type && type.toLowerCase() !== options.type.toLowerCase()) {
        continue;
      }

      console.log(chalk.bold(`\n📦 ${type} Hooks:\n`));

      let found = false;
      for (const [agentName, agentConfig] of Object.entries(AGENTS)) {
        const adapter = getHookAdapter(agentName);
        const hookPath = adapter.getHookPath(type, false);

        if (existsSync(hookPath)) {
          const files = readdirSync(hookPath).filter((f) => f.endsWith(".md"));
          if (files.length > 0) {
            found = true;
            for (const file of files) {
              console.log(
                `  ${chalk.green(file.replace(".md", ""))} ${chalk.dim(`(${agentConfig.displayName})`)}`,
              );
            }
          }
        }
      }

      if (!found) {
        console.log(`  ${chalk.dim("No hooks installed")}`);
      }
    }
    console.log("");
  }
}

/** Install a hook */
async function installHook(
  source: string,
  options: {
    global?: boolean;
    agent?: string[];
    type?: string;
    all?: boolean;
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
      message: "Install hook to which agents?",
      options: agentChoices,
      initialValues: ["claude"],
      required: true,
    });

    if (p.isCancel(selected)) {
      p.cancel("Installation cancelled");
      return;
    }
    agents = selected as string[];
  }

  // Determine hook type
  let hookType = options.type;
  if (!hookType) {
    const typeSelect = await p.select({
      message: "Select hook type:",
      options: [
        { value: "SessionStart", label: "SessionStart" },
        { value: "SessionEnd", label: "SessionEnd" },
        { value: "PreToolUse", label: "PreToolUse" },
        { value: "PostToolUse", label: "PostToolUse" },
      ],
    });

    if (p.isCancel(typeSelect)) {
      p.cancel("Installation cancelled");
      return;
    }
    hookType = typeSelect;
  }

  let hookConfig: HookInstallConfig | null = null;
  let hookContent: string | null = null;
  let tempDir: string | null = null;

  try {
    // Check if source is a well-known name
    const availableHooks = await getAvailableHooks();
    const namedHook = availableHooks.find((h) => h.name === source);

    if (namedHook) {
      // Fetch from registry
      const config = await searchConfigs(source, { type: ComponentType.HOOK });
      if (config.length > 0) {
        hookContent = config[0].content;
        const parsed = parseHookFile(hookContent);
        hookConfig = {
          name: parsed.name,
          type: parsed.type,
          script: parsed.content,
          priority: parsed.priority,
        };
      }
    } else {
      // Parse as Git URL or local path
      const parsed = parseSource(source);

      if (parsed.type === "local") {
        // Read local hook file
        const hookPath = parsed.localPath!.endsWith(".md")
          ? parsed.localPath!
          : join(parsed.localPath!, "hook.md");

        if (existsSync(hookPath)) {
          const { readFileSync } = await import("node:fs");
          hookContent = readFileSync(hookPath, "utf-8");
          const parsed = parseHookFile(hookContent);
          hookConfig = {
            name: parsed.name,
            type: parsed.type,
            script: parsed.content,
            priority: parsed.priority,
          };
        } else {
          throw new Error(`Hook file not found in ${parsed.localPath}`);
        }
      } else {
        // Clone Git repository
        tempDir = join(tmpdir(), `hook-install-${Date.now()}`);
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

        const hookPath = join(tempDir, "hook.md");
        if (existsSync(hookPath)) {
          const { readFileSync } = await import("node:fs");
          hookContent = readFileSync(hookPath, "utf-8");
          const parsed = parseHookFile(hookContent);
          hookConfig = {
            name: parsed.name,
            type: parsed.type,
            script: parsed.content,
            priority: parsed.priority,
          };
        } else {
          throw new Error("hook.md not found in repository");
        }
      }
    }

    if (!hookConfig) {
      throw new Error("Could not parse hook configuration");
    }

    // Override type from options
    hookConfig.type = hookType as HookInstallConfig["type"];

    // Install to agents
    console.log(chalk.bold(`\n📦 Installing hook: ${hookConfig.name}\n`));

    for (const agentName of agents) {
      const spinner = ora(`Installing to ${AGENTS[agentName].displayName}...`).start();
      try {
        const adapter = getHookAdapter(agentName);
        const hookPath = adapter.getHookPath(hookConfig.type, !!options.global);
        const fileName = adapter.getHookFileName(hookConfig.name);
        const targetPath = join(hookPath, fileName);

        // Ensure directory exists
        await mkdir(hookPath, { recursive: true });

        // Translate and write hook
        const translatedContent = adapter.translateHook(hookConfig);
        await writeFile(targetPath, translatedContent, "utf-8");

        spinner.succeed(`${AGENTS[agentName].displayName}`);
      } catch (err: unknown) {
        spinner.fail(`${AGENTS[agentName].displayName}: ${(err as Error).message}`);
      }
    }

    console.log(chalk.bold.green(`\n✨ Hook installed successfully\n`));
  } finally {
    // Cleanup temp directory
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Remove a hook */
async function removeHook(
  name: string,
  options: { global?: boolean; agent?: string[]; type?: string },
): Promise<void> {
  const { existsSync: fsExistsSync } = await import("node:fs");
  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const agents = options.agent || Object.keys(AGENTS);

  for (const agentName of agents) {
    const adapter = getHookAdapter(agentName);

    // Try each hook type if not specified
    const types = options.type
      ? [options.type]
      : ["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse"];

    for (const type of types) {
      const hookPath = adapter.getHookPath(type, !!options.global);
      const fileName = adapter.getHookFileName(name);
      const targetPath = join(hookPath, fileName);

      if (fsExistsSync(targetPath)) {
        await rm(targetPath, { force: true });
        console.log(chalk.green(`✓ Removed "${name}" from ${agentName} (${type})`));
      }
    }
  }

  console.log("");
}

/** Register hooks commands */
export function registerHooksCommands(program: Command): void {
  const hooksCmd = program.command("hooks").description("Lifecycle hooks management");

  // Install command
  hooksCmd
    .command("install <source>")
    .description("Install a hook from registry, Git URL, or local path")
    .option("-g, --global", "Install globally")
    .option("-a, --agent <agents...>", "Target specific agents")
    .option("-t, --type <type>", "Hook type (SessionStart, SessionEnd, PreToolUse, PostToolUse)")
    .option("--all", "Install to all agents")
    .action(installHook);

  // List command
  hooksCmd
    .command("list")
    .description("List hooks")
    .option("--installed", "List installed hooks")
    .option("--available", "List available hooks from registries")
    .option("-t, --type <type>", "Filter by hook type")
    .action(listHooks);

  // Remove command
  hooksCmd
    .command("remove <name>")
    .description("Remove an installed hook")
    .option("-g, --global", "Remove from global config")
    .option("-a, --agent <agents...>", "Target specific agents")
    .option("-t, --type <type>", "Hook type")
    .action(removeHook);
}

/**
 * Interactive TUI Mode
 *
 * Launches an interactive interface for managing skills, MCP servers, agents, and hooks.
 * Run with `bun run dev` or `skills dev`
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import { ComponentType } from "../types/index.js";

/** Mode types for the interactive interface */
type Mode = "skills" | "mcp" | "agents" | "hooks";

/** Main interactive loop */
export async function runInteractiveMode(): Promise<void> {
  let currentMode: Mode = "skills";
  let running = true;

  console.clear();
  p.intro(chalk.bold.cyan("🚀 Agent Skills CLI - Interactive Mode"));

  while (running) {
    const mode = await p.select({
      message: `Current mode: ${chalk.bold.cyan(currentMode.toUpperCase())}. What would you like to do?`,
      options: [
        {
          value: "switch",
          label: "Switch Mode",
          hint: `Current: ${currentMode}`,
        },
        {
          value: "list",
          label: "List Available",
          hint: `Show all ${currentMode}`,
        },
        {
          value: "install",
          label: "Install",
          hint: `Install ${currentMode.slice(0, -1)}`,
        },
        {
          value: "remove",
          label: "Remove",
          hint: `Remove installed ${currentMode.slice(0, -1)}`,
        },
        {
          value: "status",
          label: "Status",
          hint: "Show installation status",
        },
        { value: "exit", label: "Exit" },
      ],
    });

    if (p.isCancel(mode)) {
      running = false;
      continue;
    }

    switch (mode) {
      case "switch":
        currentMode = await selectMode();
        console.clear();
        break;
      case "list":
        await handleList(currentMode);
        break;
      case "install":
        await handleInstall(currentMode);
        break;
      case "remove":
        await handleRemove(currentMode);
        break;
      case "status":
        await handleStatus(currentMode);
        break;
      case "exit":
        running = false;
        break;
    }
  }

  p.outro(chalk.green("Goodbye! 👋"));
}

/** Select a mode */
async function selectMode(): Promise<Mode> {
  const mode = await p.select({
    message: "Select mode:",
    options: [
      { value: "skills", label: "📚 Skills", hint: "Manage AI agent skills" },
      { value: "mcp", label: "🔌 MCP", hint: "Manage MCP servers" },
      {
        value: "agents",
        label: "🤖 Agents",
        hint: "Manage agent configurations",
      },
      { value: "hooks", label: "🪝 Hooks", hint: "Manage lifecycle hooks" },
    ],
  });

  if (p.isCancel(mode)) {
    return "skills";
  }

  return mode as Mode;
}

/** Handle list command */
async function handleList(mode: Mode): Promise<void> {
  const scope = await p.select({
    message: "Show:",
    options: [
      { value: "available", label: "Available (from registries)" },
      { value: "installed", label: "Installed" },
      { value: "both", label: "Both" },
    ],
  });

  if (p.isCancel(scope)) return;

  // Execute the appropriate list command
  const { execSync } = await import("node:child_process");
  try {
    if (scope === "available" || scope === "both") {
      console.log(chalk.bold(`\n📦 Available ${mode}:\n`));
      const cmd = mode === "skills" ? "search" : `${mode} list`;
      execSync(`bun run src/cli/index.ts ${cmd} --available`, {
        stdio: "inherit",
      } as any);
    }
    if (scope === "installed" || scope === "both") {
      console.log(chalk.bold(`\n📦 Installed ${mode}:\n`));
      const cmd = mode === "skills" ? "list" : `${mode} list`;
      execSync(`bun run src/cli/index.ts ${cmd} --installed`, {
        stdio: "inherit",
      } as any);
    }
  } catch {
    // Command execution failed
  }

  await p.confirm({ message: "Press Enter to continue..." });
  console.clear();
}

/** Handle install command */
async function handleInstall(mode: Mode): Promise<void> {
  const source = await p.text({
    message: `Enter ${mode === "skills" ? "skill" : mode.slice(0, -1)} source:`,
    placeholder: "owner/repo or https://...",
    validate: (value) => {
      if (!value) return "Source is required";
      return undefined;
    },
  });

  if (p.isCancel(source)) return;

  // Select target agents
  const agents = await p.multiselect({
    message: "Install to which agents?",
    options: [
      { value: "claude", label: "Claude Code" },
      { value: "cursor", label: "Cursor" },
      { value: "copilot", label: "GitHub Copilot" },
      { value: "windsurf", label: "Windsurf" },
      { value: "all", label: "All Agents" },
    ],
    required: true,
  });

  if (p.isCancel(agents)) return;

  // Execute the install command
  const { execSync } = await import("node:child_process");
  const agentFlags = (agents as string[]).includes("all")
    ? "--all"
    : (agents as string[]).map((a) => `-a ${a}`).join(" ");

  try {
    console.log(
      chalk.bold(`\n📦 Installing ${mode === "skills" ? "skill" : mode.slice(0, -1)}...\n`),
    );
    const cmd = mode === "skills" ? "install" : `${mode} install`;
    execSync(`bun run src/cli/index.ts ${cmd} ${agentFlags} ${source}`, {
      stdio: "inherit",
    } as any);
  } catch {
    console.log(chalk.yellow("\nInstallation may have encountered issues.\n"));
  }

  await p.confirm({ message: "Press Enter to continue..." });
  console.clear();
}

/** Handle remove command */
async function handleRemove(mode: Mode): Promise<void> {
  const name = await p.text({
    message: `Enter ${mode === "skills" ? "skill" : mode.slice(0, -1)} name to remove:`,
    placeholder: "name",
    validate: (value) => {
      if (!value) return "Name is required";
      return undefined;
    },
  });

  if (p.isCancel(name)) return;

  const confirm = await p.confirm({
    message: `Remove "${name}" from all agents?`,
  });

  if (!confirm || p.isCancel(confirm)) return;

  // Execute the remove command
  const { execSync } = await import("node:child_process");
  try {
    const cmd = mode === "skills" ? "remove" : `${mode} remove`;
    execSync(`bun run src/cli/index.ts ${cmd} ${name}`, {
      stdio: "inherit",
    } as any);
    console.log(chalk.green(`\n✓ Removed "${name}"\n`));
  } catch {
    console.log(chalk.yellow("\nRemoval may have encountered issues.\n"));
  }

  await p.confirm({ message: "Press Enter to continue..." });
  console.clear();
}

/** Handle status command */
async function handleStatus(mode: Mode): Promise<void> {
  const { execSync } = await import("node:child_process");

  console.log(chalk.bold(`\n📊 ${mode.toUpperCase()} Status\n`));

  // Show info command output
  try {
    execSync("bun run src/cli/index.ts info", {
      stdio: "inherit",
    } as any);
  } catch {
    // Ignore errors
  }

  await p.confirm({ message: "Press Enter to continue..." });
  console.clear();
}

/** Register the dev command */
export function registerDevCommand(program: Command): void {
  program
    .command("dev")
    .description("Launch interactive TUI mode for managing skills, MCP, agents, and hooks")
    .action(async () => {
      try {
        await runInteractiveMode();
      } catch (err: unknown) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Skill Installer Module
 * Handles symlink-based installation of skills to agent directories
 */

import { existsSync } from "node:fs";
import { cp, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ComponentType, type InstallResult } from "../types/index.js";

/**
 * Agent configuration interface
 */
export interface AgentConfig {
  name: string;
  displayName: string;
  projectDir: string;
  globalDir: string;
}

/**
 * Installation options
 */
export interface InstallOptions {
  global: boolean;
  agents: string[];
  cwd: string;
}

/**
 * Information about an installed skill
 */
export interface InstalledSkillInfo {
  name: string;
  canonicalPath: string;
  agents: string[];
  linkedPaths: string[];
  method: "symlink" | "copy";
}

/**
 * Get the canonical skills storage directory
 * - Global: ~/.skills/
 * - Project: .skills/
 */
export function getCanonicalSkillsDir(global: boolean, cwd: string): string {
  return global ? join(homedir(), ".skills") : join(cwd, ".skills");
}

/**
 * Get the canonical path for a specific skill
 */
export function getCanonicalPath(
  skillName: string,
  options: { global: boolean; cwd: string },
): string {
  return join(getCanonicalSkillsDir(options.global, options.cwd), skillName);
}

/**
 * Get the agent skill directory path
 */
export function getAgentSkillPath(
  skillName: string,
  agentConfig: AgentConfig,
  options: { global: boolean; cwd: string },
): string {
  const baseDir = options.global
    ? agentConfig.globalDir
    : join(options.cwd, agentConfig.projectDir);
  return join(baseDir, skillName);
}

/**
 * Check if a path is a symlink
 */
export async function isSymlink(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Create a symlink, falling back to copy if symlinks fail (Windows)
 */
async function createSymlinkOrCopy(source: string, target: string): Promise<"symlink" | "copy"> {
  try {
    // Remove existing target if any
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
    }

    // Ensure parent directory exists
    await mkdir(dirname(target), { recursive: true });

    // Try creating symlink
    await symlink(source, target, "junction"); // 'junction' works on Windows without admin
    return "symlink";
  } catch (err: any) {
    // Symlink failed, fall back to copy
    console.warn(`Symlink failed, using copy: ${err.message}`);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
    return "copy";
  }
}

/**
 * Install a skill with symlinks to each agent
 *
 * @param sourcePath - Path to downloaded skill (temp directory)
 * @param skillName - Name of the skill
 * @param agents - Map of agent configs to install to
 * @param options - Install options
 */
export async function installSkillWithSymlinks(
  sourcePath: string,
  skillName: string,
  agentConfigs: Record<string, AgentConfig>,
  targetAgents: string[],
  options: InstallOptions,
): Promise<InstalledSkillInfo> {
  const canonicalPath = getCanonicalPath(skillName, options);

  // 1. Create canonical directory and copy skill
  await mkdir(dirname(canonicalPath), { recursive: true });

  // Remove existing canonical copy if any
  if (existsSync(canonicalPath)) {
    await rm(canonicalPath, { recursive: true, force: true });
  }

  // Copy to canonical location
  await cp(sourcePath, canonicalPath, { recursive: true });

  // 2. Create symlinks/copies for each agent
  const linkedPaths: string[] = [];
  let method: "symlink" | "copy" = "symlink";

  for (const agentName of targetAgents) {
    const agentConfig = agentConfigs[agentName];
    if (!agentConfig) continue;

    const agentSkillPath = getAgentSkillPath(skillName, agentConfig, options);

    const linkMethod = await createSymlinkOrCopy(canonicalPath, agentSkillPath);
    if (linkMethod === "copy") {
      method = "copy"; // If any fails, mark as copy
    }

    linkedPaths.push(agentSkillPath);
  }

  return {
    name: skillName,
    canonicalPath,
    agents: targetAgents,
    linkedPaths,
    method,
  };
}

/**
 * Remove a skill from all its installed locations
 */
export async function removeSkillInstallation(
  skillName: string,
  agentConfigs: Record<string, AgentConfig>,
  agents: string[],
  options: { global: boolean; cwd: string },
): Promise<void> {
  // Remove from each agent directory
  for (const agentName of agents) {
    const agentConfig = agentConfigs[agentName];
    if (!agentConfig) continue;

    const agentSkillPath = getAgentSkillPath(skillName, agentConfig, options);

    if (existsSync(agentSkillPath)) {
      await rm(agentSkillPath, { recursive: true, force: true });
    }
  }

  // Remove canonical copy
  const canonicalPath = getCanonicalPath(skillName, options);
  if (existsSync(canonicalPath)) {
    await rm(canonicalPath, { recursive: true, force: true });
  }
}

/**
 * Check if a skill is installed via symlink or copy
 */
export async function getSkillInstallMethod(
  skillName: string,
  agentConfig: AgentConfig,
  options: { global: boolean; cwd: string },
): Promise<"symlink" | "copy" | "none"> {
  const agentSkillPath = getAgentSkillPath(skillName, agentConfig, options);

  if (!existsSync(agentSkillPath)) {
    return "none";
  }

  if (await isSymlink(agentSkillPath)) {
    return "symlink";
  }

  return "copy";
}

// ── Unified Component Installation ─────────────────────────────────────────────

/**
 * Get the canonical directory for a component type
 * - Global: ~/.agent/<type>s/
 * - Project: .agent/<type>s/
 */
export function getCanonicalComponentDir(
  componentType: ComponentType,
  global: boolean,
  cwd: string,
): string {
  const base = global ? join(homedir(), ".agent") : join(cwd, ".agent");
  return join(base, `${componentType}s`); // skills, agents, mcp, hooks
}

/**
 * Get the agent-specific component path
 */
export function getAgentComponentPath(
  agentConfig: AgentConfig,
  componentType: ComponentType,
  global: boolean,
  cwd: string,
): string {
  const basePath = global ? agentConfig.globalDir : join(cwd, agentConfig.projectDir);
  // Map component type to agent-specific subdirectory
  const typeMap: Record<ComponentType, string> = {
    [ComponentType.SKILL]: "skills",
    [ComponentType.AGENT]: "agents",
    [ComponentType.MCP]: "mcp",
    [ComponentType.HOOK]: "hooks",
  };
  // For skills, use the existing pattern
  if (componentType === ComponentType.SKILL) {
    return basePath;
  }
  // For other components, navigate to parent and add component directory
  return join(dirname(basePath), typeMap[componentType]);
}

/**
 * Install a component with symlinks to each agent
 * Extends the skill installation pattern to support multiple component types
 *
 * @param sourcePath - Path to downloaded component (temp directory)
 * @param componentName - Name of the component
 * @param componentType - Type of component (skill, agent, mcp, hook)
 * @param agentConfigs - Map of all available agent configs
 * @param targetAgents - List of agent names to install to
 * @param options - Install options
 */
export async function installComponentWithSymlinks(
  sourcePath: string,
  componentName: string,
  componentType: ComponentType,
  agentConfigs: Record<string, AgentConfig>,
  targetAgents: string[],
  options: InstallOptions,
): Promise<InstallResult> {
  const canonicalDir = getCanonicalComponentDir(componentType, options.global, options.cwd);
  const canonicalPath = join(canonicalDir, componentName);

  // 1. Create canonical directory and copy component
  await mkdir(canonicalDir, { recursive: true });

  // Remove existing canonical copy if any
  if (existsSync(canonicalPath)) {
    await rm(canonicalPath, { recursive: true, force: true });
  }

  // Copy to canonical location
  await cp(sourcePath, canonicalPath, { recursive: true });

  // 2. Create symlinks/copies for each agent
  const installations: InstallResult["installations"] = [];

  for (const agentName of targetAgents) {
    const agentConfig = agentConfigs[agentName];
    if (!agentConfig) continue;

    const agentPath = getAgentComponentPath(
      agentConfig,
      componentType,
      options.global,
      options.cwd,
    );
    const targetPath = join(agentPath, componentName);

    const method = await createSymlinkOrCopy(canonicalPath, targetPath);

    installations.push({
      agent: agentName,
      method,
      path: targetPath,
    });
  }

  return {
    success: true,
    installations,
  };
}

/**
 * Remove a component from all its installed locations
 */
export async function removeComponentInstallation(
  componentName: string,
  componentType: ComponentType,
  agentConfigs: Record<string, AgentConfig>,
  agents: string[],
  options: { global: boolean; cwd: string },
): Promise<void> {
  // Remove from each agent directory
  for (const agentName of agents) {
    const agentConfig = agentConfigs[agentName];
    if (!agentConfig) continue;

    const agentPath = getAgentComponentPath(
      agentConfig,
      componentType,
      options.global,
      options.cwd,
    );
    const targetPath = join(agentPath, componentName);

    if (existsSync(targetPath)) {
      await rm(targetPath, { recursive: true, force: true });
    }
  }

  // Remove canonical copy
  const canonicalDir = getCanonicalComponentDir(componentType, options.global, options.cwd);
  const canonicalPath = join(canonicalDir, componentName);
  if (existsSync(canonicalPath)) {
    await rm(canonicalPath, { recursive: true, force: true });
  }
}

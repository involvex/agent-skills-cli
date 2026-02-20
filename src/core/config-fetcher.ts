/**
 * Configuration Fetcher Module
 *
 * Fetches agent-MCP configurations from well-known sources,
 * ensuring up-to-date and reliable configurations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ComponentType } from "../types/index.js";

const home = homedir();

// ── Type Definitions ──────────────────────────────────────────────────────────

export interface ConfigRegistry {
  name: string;
  type: "git" | "api";
  url: string;
  priority: number;
}

export interface FetchedConfig {
  name: string;
  type: ComponentType;
  source: string;
  registry: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface FetchOptions {
  registries?: string[];
  type?: ComponentType;
  platform?: string;
}

// ── Registry Configuration ───────────────────────────────────────────────────

const REGISTRY_CONFIG_PATH = join(home, ".agent", "registry.json");
const CACHE_DIR = join(home, ".agent", "cache");

/**
 * Default well-known registries
 */
export const DEFAULT_REGISTRIES: ConfigRegistry[] = [
  {
    name: "official",
    type: "git",
    url: "https://github.com/agent-skills/configs",
    priority: 100,
  },
  {
    name: "community",
    type: "api",
    url: "https://api.agent-skills.io/configs",
    priority: 50,
  },
];

/**
 * Get all configured registries
 */
export function getConfigRegistries(): ConfigRegistry[] {
  if (existsSync(REGISTRY_CONFIG_PATH)) {
    try {
      const content = readFileSync(REGISTRY_CONFIG_PATH, "utf-8");
      const data = JSON.parse(content);
      return data.registries || DEFAULT_REGISTRIES;
    } catch {
      return DEFAULT_REGISTRIES;
    }
  }
  return DEFAULT_REGISTRIES;
}

/**
 * Add a new registry
 */
export function addRegistry(registry: ConfigRegistry): void {
  const registries = getConfigRegistries();
  const existingIndex = registries.findIndex((r) => r.name === registry.name);

  if (existingIndex >= 0) {
    registries[existingIndex] = registry;
  } else {
    registries.push(registry);
  }

  // Sort by priority
  registries.sort((a, b) => b.priority - a.priority);

  // Ensure directory exists
  const dir = join(REGISTRY_CONFIG_PATH, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(
    REGISTRY_CONFIG_PATH,
    JSON.stringify({ version: "1.0", registries }, null, 2),
    "utf-8",
  );
}

/**
 * Remove a registry by name
 */
export function removeRegistry(name: string): boolean {
  const registries = getConfigRegistries();
  const filtered = registries.filter((r) => r.name !== name);

  if (filtered.length === registries.length) {
    return false; // Not found
  }

  writeFileSync(
    REGISTRY_CONFIG_PATH,
    JSON.stringify({ version: "1.0", registries: filtered }, null, 2),
    "utf-8",
  );

  return true;
}

// ── Config Fetching ──────────────────────────────────────────────────────────

/**
 * Fetch configurations from all configured sources
 */
export async function fetchConfigs(options: FetchOptions = {}): Promise<FetchedConfig[]> {
  let registries = getConfigRegistries();

  // Filter by user-specified registries
  if (options.registries && options.registries.length > 0) {
    registries = registries.filter((r) => options.registries?.includes(r.name));
  }

  const results = await Promise.allSettled(
    registries.map((registry) => fetchFromSource(registry, options)),
  );

  const configs: FetchedConfig[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      configs.push(...result.value);
    }
  }

  return configs;
}

/**
 * Fetch configurations from a specific source
 */
async function fetchFromSource(
  registry: ConfigRegistry,
  options: FetchOptions,
): Promise<FetchedConfig[]> {
  switch (registry.type) {
    case "git":
      return fetchFromGitSource(registry, options);
    case "api":
      return fetchFromAPISource(registry, options);
    default:
      return [];
  }
}

/**
 * Fetch from Git repository
 */
async function fetchFromGitSource(
  registry: ConfigRegistry,
  options: FetchOptions,
): Promise<FetchedConfig[]> {
  const { execSync } = require("node:child_process");

  // Ensure cache directory exists
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  const cachePath = join(CACHE_DIR, `registry-${registry.name}`);

  // Clone or update the repository
  if (existsSync(cachePath)) {
    try {
      execSync("git fetch --depth 1", { cwd: cachePath, stdio: "ignore" });
      execSync("git reset --hard origin/main", {
        cwd: cachePath,
        stdio: "ignore",
      });
    } catch {
      // Fetch failed, may need to re-clone
    }
  } else {
    try {
      execSync(`git clone --depth 1 ${registry.url} ${cachePath}`, {
        stdio: "ignore",
      });
    } catch {
      return []; // Clone failed
    }
  }

  // Parse config files from the cloned repository
  return parseConfigsFromDirectory(cachePath, registry.name, options);
}

/**
 * Fetch from API endpoint
 */
async function fetchFromAPISource(
  registry: ConfigRegistry,
  options: FetchOptions,
): Promise<FetchedConfig[]> {
  try {
    const url = new URL(registry.url);

    // Add query parameters
    if (options.type) {
      url.searchParams.set("type", options.type);
    }
    if (options.platform) {
      url.searchParams.set("platform", options.platform);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      return [];
    }

    const data: unknown = await response.json();

    // Handle different API response formats
    if (Array.isArray(data)) {
      return data.map((item: unknown) => ({
        ...(item as Partial<FetchedConfig>),
        registry: registry.name,
      })) as FetchedConfig[];
    }

    if (data && typeof data === "object" && "configs" in data && Array.isArray(data.configs)) {
      return data.configs.map((item: unknown) => ({
        ...(item as Partial<FetchedConfig>),
        registry: registry.name,
      })) as FetchedConfig[];
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Parse configuration files from a directory
 */
function parseConfigsFromDirectory(
  dir: string,
  registryName: string,
  options: FetchOptions,
): FetchedConfig[] {
  const { readdirSync, statSync } = require("node:fs");
  const configs: FetchedConfig[] = [];

  if (!existsSync(dir)) {
    return configs;
  }

  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Recursively search subdirectories
      configs.push(...parseConfigsFromDirectory(fullPath, registryName, options));
    } else if (entry.endsWith(".json")) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const data = JSON.parse(content);

        // Filter by type if specified
        if (options.type && data.type !== options.type) {
          continue;
        }

        // Filter by platform if specified
        if (options.platform && data.platforms && !data.platforms.includes(options.platform)) {
          continue;
        }

        configs.push({
          name: data.name || entry.replace(".json", ""),
          type: data.type || "skill",
          source: data.source || fullPath,
          registry: registryName,
          content: JSON.stringify(data, null, 2),
          metadata: data.metadata || {},
        });
      } catch {
        // Skip invalid JSON files
      }
    } else if (entry.endsWith(".md")) {
      try {
        const content = readFileSync(fullPath, "utf-8");

        // Extract metadata from YAML frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const metadata: Record<string, unknown> = {};

        if (frontmatterMatch) {
          const yaml = frontmatterMatch[1];
          for (const line of yaml.split("\n")) {
            const match = line.match(/^(\w+):\s*(.+)$/);
            if (match) {
              const [, key, value] = match;
              metadata[key] = value;
            }
          }
        }

        // Filter by type if specified
        if (options.type && metadata.type !== options.type) {
          continue;
        }

        configs.push({
          name: (metadata.name as string) || entry.replace(".md", ""),
          type: (metadata.type as ComponentType) || "skill",
          source: fullPath,
          registry: registryName,
          content,
          metadata,
        });
      } catch {
        // Skip invalid markdown files
      }
    }
  }

  return configs;
}

/**
 * Search for available configurations
 */
export async function searchConfigs(
  query: string,
  options: FetchOptions = {},
): Promise<FetchedConfig[]> {
  const allConfigs = await fetchConfigs(options);

  // Simple search by name or description
  const lowerQuery = query.toLowerCase();
  return allConfigs.filter(
    (config) =>
      config.name.toLowerCase().includes(lowerQuery) ||
      config.metadata?.description?.toString().toLowerCase().includes(lowerQuery),
  );
}

/**
 * Get a specific configuration by name
 */
export async function getConfigByName(
  name: string,
  options: FetchOptions = {},
): Promise<FetchedConfig | null> {
  const allConfigs = await fetchConfigs(options);
  return allConfigs.find((c) => c.name === name) || null;
}

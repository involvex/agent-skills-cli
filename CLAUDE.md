# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Agent Skills CLI - Universal CLI for managing AI agent skills across 42+ AI coding platforms (Cursor, Claude Code, GitHub Copilot, Windsurf, Cline, Gemini CLI, Zed, etc.). Implements the open Agent Skills specification (agentskills.io).

## Commands

```bash
npm run build          # TypeScript compilation to dist/
npm run build:fast     # Fast build using tsup
npm run dev            # Development mode with bun
npm run test           # Run tests with vitest
npm run start          # Run the compiled CLI
```

## Architecture

The codebase follows a three-layer architecture:

1. **CLI Layer** (`src/cli/`) - Command parsing, user interaction, CLI orchestration using Commander.js
2. **Core Layer** (`src/core/`) - Business logic, marketplace integration, skill management
3. **Adapter Layer** (`src/adapters/`) - Platform-specific implementations (Claude, Cursor, Copilot, universal)

### Key Directories

- `src/cli/commands/` - 41 command modules (install, add, remove, search, validate, etc.)
- `src/cli/agents.ts` - Agent configurations for all 42 supported platforms
- `src/core/loader.ts` - Skill discovery and loading from filesystem
- `src/core/marketplace.ts` - Marketplace integration with Supabase backend
- `src/core/installer.ts` - Installation management and symlink handling
- `src/core/source-parser.ts` - Multi-source parsing (GitHub, GitLab, Bitbucket, SSH, npm, local, URLs)
- `src/core/git-auth.ts` - Authentication detection and resolution
- `src/core/validator.ts` - Skill validation against the specification
- `src/adapters/` - Platform adapters for different AI agents
- `src/types/` - TypeScript type definitions

## Skill Format

Skills are defined as `SKILL.md` files with YAML frontmatter:

```yaml
---
name: my-skill
description: What this skill does
license: MIT
compatibility: 1.0.0
allowed-tools: Bash Read Write
---

# Instructions

Your skill instructions here...
```

Required fields: `name`, `description`

## Agent Paths

Each AI platform has standardized paths (defined in `src/cli/agents.ts`):

- **Project-local**: `.cursor/skills/`, `.claude/skills/`, `.github/skills/`
- **Global**: `~/.cursor/skills/`, `~/.claude/skills/`, `~/.github/skills/`

Installation creates symlinks from the source skill directory to these platform-specific locations.

## Source Parser

The source parser (`src/core/source-parser.ts`) handles multiple input formats:

- `owner/repo` - GitHub shorthand
- `owner/repo@skill` - GitHub with specific skill
- `git@host:repo.git` - SSH URLs (auto-detects SSH keys)
- `https://...` - HTTPS URLs (GitHub, GitLab, Bitbucket)
- `npm:package` - npm packages
- `./local/path` - Local filesystem paths

Auth resolution order: `--token` flag → env vars (`GH_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`, `GIT_TOKEN`) → SSH keys → git credential helper → `.netrc`

## Configuration

`.skillsrc` or `.skillsrc.json` files (project or home directory) configure:

- Private Git repositories and registries
- Custom npm registries
- Authentication tokens
- Default agent targets

Lock file tracking: `~/.skills/skills.lock`

## v1.1.4 Power Tools

Recent release introduced 10 unique features:

- `doctor --deep` - Conflict detection across skills
- `budget -b <tokens>` - Context-aware skill selection
- `diff <A> <B>` - Section-aware skill comparison
- `compose <skills...>` - Merge/chain skills
- `test [skills...]` - Quality assertions
- `frozen` - Deterministic lockfile-based installs
- `sandbox <source>` - Preview before install
- `watch [dir]` - Auto-sync on file changes
- `split <skill>` - Split large skills
- `bench [skills...]` - Skill quality benchmarking

## CLI Entry Points

- `src/cli/index.ts` - Main CLI entry point (executable)
- `src/index.ts` - Library entry point for programmatic use
- Binary name: `skills` or `agent-skills`

## Type Definitions

Core types (`src/types/index.ts`):
- `Skill` - Full skill with metadata, body, path
- `SkillMetadata` - Frontmatter data (name, description, license, etc.)
- `SkillRef` - Lightweight reference for discovery
- `ValidationResult` - Skill validation output

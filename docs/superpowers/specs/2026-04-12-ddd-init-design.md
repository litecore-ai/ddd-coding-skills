# ddd-init Skill Design Spec

> **Date**: 2026-04-12
> **Status**: Draft
> **Author**: Terry Zhang + Claude
> **Plugin**: ddd-coding-skills v1.6.0 → v1.7.0

## Summary

A new `ddd-init` skill that initializes or refactors a project into DDD architecture. For new projects, it creates the full DDD directory structure (including standardized `docs/`). For existing projects, it creates the target structure and generates a refactoring roadmap compatible with `ddd-auto`/`ddd-develop`. Architecture constraints are written to `CLAUDE.md` to ensure all downstream skills follow the established structure.

## Motivation

Currently, `ddd-develop` assumes a DDD structure already exists. Projects starting from generic scaffolds (e.g., `create-next-app`, `cargo init`) or existing codebases without DDD organization have no guided path to adopt the architecture. `ddd-init` fills this gap as the entry point of the pipeline:

```
ddd-init → ddd-roadmap → ddd-develop/ddd-auto → ddd-audit
```

## Architecture: Skill + Command

### New Files

```
ddd-coding-skills/
├── skills/
│   └── ddd-init/
│       └── SKILL.md          # Main skill (detection, scaffolding, refactor planning)
└── commands/
    └── ddd-init.md            # /ddd-init slash command entry point
```

### Modified Files

- `package.json` — bump version to 1.7.0
- `.claude-plugin/plugin.json` — bump version, update description
- `.claude-plugin/marketplace.json` — bump version, update description
- `README.md` / `README.zh-CN.md` — document new skill

---

## Input Modes

```bash
# New project: use built-in fastlayer template
/ddd-init --template fastlayer

# New project: use custom reference architecture
/ddd-init --ref ~/Developer/open-sources/fastlayer

# Existing project: auto-detect tech stack, recommend template
/ddd-init

# Existing project: specify reference architecture
/ddd-init --ref ~/my-other-ddd-project
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--template <name>` | Built-in template name. Currently: `fastlayer` | Auto-detect / ask user |
| `--ref <path>` | Path to a reference project. ddd-init scans its directory tree to extract DDD layer mapping. | None |

`--template` and `--ref` are mutually exclusive. If both are provided, `--ref` takes precedence.

---

## Project State Detection

ddd-init automatically determines the mode based on project signals:

| Signal | Mode |
|--------|------|
| No source code directories (`src/`, `server/`, `app/`, `lib/`) or only scaffolding boilerplate | **Scaffold** — create DDD structure from scratch |
| Source code exists but no DDD layer directories (`domain/`, `modules/*/app/`, `repo/`) | **Refactor** — create DDD structure + generate migration roadmap |
| DDD layer directories already exist | **Already DDD** — inform user, offer to audit or adjust |

### Tech Stack Detection

Detect from package manifest and file extensions:

| File | Stack |
|------|-------|
| `package.json` + `next.config.*` | TypeScript / Next.js |
| `package.json` + `express` or `fastify` dep | TypeScript / Node.js |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `pom.xml` / `build.gradle` | Java / Kotlin |
| `requirements.txt` / `pyproject.toml` | Python |

Tech stack determines which built-in template to recommend and how to adapt directory names.

---

## Scaffold Mode (New Project)

### Execution Flow

```
Step 1: Detect project state → New project
    ↓
Step 2: Determine reference architecture
  - --template fastlayer → use built-in template
  - --ref <path> → scan reference project directory tree
  - No option → detect tech stack, recommend template (or ask)
    ↓
Step 3: Confirm tech stack context
  - Framework, language, existing directories
  - Present proposed structure, ask user confirmation
    ↓
Step 4: Create DDD directory structure
  - Create all layer directories
  - Place .gitkeep in empty directories
    ↓
Step 5: Create standardized docs/ structure
    ↓
Step 6: Write architecture constraints to CLAUDE.md
    ↓
Step 7: User confirmation + commit
```

### Output: DDD Directory Structure

Created directories (adapted to tech stack, example for Next.js/fastlayer):

```
server/
├── handler/                    # Presentation layer
├── infras/                     # Shared infrastructure
│   ├── orm/
│   │   └── schema/
│   ├── auth/
│   └── utils/
└── modules/                    # Bounded contexts root
    └── .gitkeep
```

### Output: Standardized docs/ Structure

```
docs/
├── roadmap/                    # ddd-roadmap output
│   └── .gitkeep
├── audit/                      # ddd-audit output
│   └── .gitkeep
├── architecture/               # Architecture documentation
│   └── .gitkeep
└── superpowers/
    ├── specs/                  # Design specifications
    │   └── .gitkeep
    └── plans/                  # Implementation plans
        └── .gitkeep
```

### Output: CLAUDE.md Architecture Section

ddd-init appends (or creates) a `## DDD Architecture` section in `CLAUDE.md`:

```markdown
## DDD Architecture

> Generated by ddd-init. Downstream skills (ddd-develop, ddd-audit) use this
> section to enforce architectural compliance.

### Layer Mapping

| Layer | Directory | Responsibility |
|-------|-----------|----------------|
| Presentation | `server/handler/` | Request handling, response formatting |
| Application | `server/modules/*/app/` | Service orchestration, DTO transformation |
| Domain | `server/modules/*/domain/` | Business logic, entities, value objects — pure, no IO |
| Repository | `server/modules/*/repo/` | Data access, PO ↔ Entity mapping |
| ACL | `server/modules/*/acl/` | External service adapters (anti-corruption layer) |
| Infrastructure | `server/infras/` | Shared infra (ORM, auth, email, etc.) |

### Module Template

New modules MUST follow this structure:

```
server/modules/<module>/
├── acl/                        # Anti-Corruption Layer
├── app/
│   ├── dto/                    # Data Transfer Objects
│   ├── service/                # Application services
│   └── internal/               # Cross-module interfaces
├── domain/
│   ├── bo/                     # Business Objects (logic + validation)
│   └── model/
│       ├── entity/             # Entities (identity-based)
│       ├── vo/                 # Value Objects (equality-based)
│       └── qo/                 # Query Objects
├── repo/
│   ├── dao/                    # Data Access Objects
│   └── po/                     # Persistent Objects
└── utils/                      # Module-scoped utilities
```

### Dependency Rules

```
Domain → (nothing)              # Pure layer, no IO, no framework deps
Application → Domain
Repository → Domain             # Interfaces in domain, impls in repo
ACL → Domain                    # Adapts external services to domain interfaces
Presentation → Application
Infrastructure ← ACL, Repository  # Shared infra consumed by outer layers
```

### Conventions

- Tuple return pattern: `[data, error]` for all async functions
- ServiceError objects for business errors (never `new Error()` for 4xx)
- Type separation: DTO (API) ↔ Entity (Domain) ↔ PO (Database)
- Immutability: prefer immutable data structures in domain layer
```

The exact content is adapted based on the reference architecture used. The above is the fastlayer template default.

---

## Refactor Mode (Existing Project)

### Execution Flow

```
Step 1: Detect project state → Existing project
    ↓
Step 2: Determine reference architecture (same as scaffold)
    ↓
Step 3: Analyze existing code structure
  - Scan all source directories, count files per directory
  - Classify each directory/file into DDD layers (heuristic):
    * Files with DB queries, ORM models → Repository/Infrastructure
    * Files with business logic, validation → Domain
    * Files with HTTP handlers, controllers → Presentation
    * Files with service orchestration → Application
    * Files integrating external APIs → ACL
  - Identify existing modules/bounded contexts
    ↓
Step 4: Present analysis to user
  - Show current structure mapping
  - Show proposed target structure
  - Ask for confirmation/adjustments
    ↓
Step 5: Create target DDD directory structure (same as scaffold)
    ↓
Step 6: Create standardized docs/ structure (same as scaffold)
    ↓
Step 7: Generate refactoring roadmap
  - Output to docs/roadmap/ in standard ddd-roadmap format
  - P0: Foundation — create DDD directories, establish layer interfaces
  - P0.1: Move domain logic to domain layer
  - P0.2: Move data access to repository layer
  - P0.3: Move external service calls to ACL
  - P0.4: Move handlers to presentation layer
  - P0.5: Move orchestration to application layer
  - Each sub-feature = one migration unit (a file or group of related files)
  - Each item describes: source path, target path, required code changes
    ↓
Step 8: Write CLAUDE.md architecture section (same as scaffold)
    ↓
Step 9: User confirmation + commit
    ↓
Step 10: Suggest next step
  - "Run /ddd-auto --roadmap docs/roadmap/ P0 to execute the refactoring"
```

### Refactoring Roadmap Format

Compatible with ddd-roadmap output (consumed by ddd-develop/ddd-auto):

```markdown
# P0: DDD Structure Migration

> **Timeline**: [estimated based on file count]
> **Goal**: Reorganize existing code into DDD layered architecture
> **Status**: Pending

## 0.1 Domain Layer Migration

### 0.1.1 Extract User Domain Logic

Move business logic from mixed service files to domain layer.

- [ ] Move user validation logic from `src/services/userService.ts` to `server/modules/user/domain/bo/userBo.ts`
- [ ] Extract User entity from `src/models/user.ts` to `server/modules/user/domain/model/entity/user.ts`
- [ ] Create UserVO in `server/modules/user/domain/model/vo/`
- [ ] Update imports across affected files

### 0.1.2 Extract Billing Domain Logic

...

## 0.2 Repository Layer Migration

### 0.2.1 Extract User Data Access

- [ ] Move user DB queries from `src/services/userService.ts` to `server/modules/user/repo/dao/userDao.ts`
- [ ] Create User PO in `server/modules/user/repo/po/user.ts`
- [ ] Define repository interface in domain layer

...
```

---

## Built-in Template: fastlayer

Inline in SKILL.md. No external template files.

### Metadata

```
Name: fastlayer
Tech Stack: TypeScript / Next.js
Reference: https://github.com/RealMatrix-PTE-LTD/fastlayer
```

### Directory Structure

```
server/
├── handler/                    # Presentation layer
│   └── <domain>/               # Grouped by domain
├── infras/                     # Shared infrastructure
│   ├── orm/
│   │   ├── schema/             # Database schemas (Drizzle)
│   │   └── data-preset/        # Seed data
│   ├── auth/                   # Auth infrastructure
│   ├── utils/                  # Shared utilities
│   └── shared/                 # Shared types/constants
└── modules/                    # Bounded contexts
    └── <module>/
        ├── acl/                # Anti-Corruption Layer
        │   └── <service>/      # One subdir per external service
        ├── app/
        │   ├── dto/            # Data Transfer Objects
        │   ├── service/        # Application services
        │   │   └── __tests__/
        │   └── internal/       # Cross-module interfaces
        ├── domain/
        │   ├── bo/             # Business Objects
        │   │   └── __tests__/
        │   └── model/
        │       ├── entity/     # Entities
        │       ├── vo/         # Value Objects
        │       └── qo/         # Query Objects
        ├── repo/
        │   ├── dao/            # Data Access Objects
        │   │   └── __tests__/
        │   └── po/             # Persistent Objects
        └── utils/
```

### Conventions (fastlayer-specific)

- Request flow: `Middleware → API Route → Handler → Service → BO → DAO → Database`
- Tuple return: `[data, error]` for all async functions
- Error handling: `ServiceError` objects, never `new Error()` for 4xx
- Type system: `DTO (API) ↔ Entity (Domain) ↔ PO (Database)`
- Cross-module communication: via `app/internal/` interfaces
- Tests: colocated in `__tests__/` within each layer

---

## --ref: Custom Reference Architecture

When `--ref <path>` is provided:

1. Verify the path exists and contains source code
2. Scan the directory tree (excluding `node_modules/`, `.git/`, `dist/`, etc.)
3. Identify DDD layer directories by name patterns:
   - `domain/`, `model/`, `entity/`, `vo/` → Domain layer
   - `app/`, `service/`, `dto/` → Application layer
   - `repo/`, `dao/`, `repository/` → Repository layer
   - `acl/`, `adapter/`, `gateway/` → ACL layer
   - `handler/`, `controller/`, `api/`, `route/` → Presentation layer
   - `infra/`, `infras/`, `infrastructure/` → Infrastructure layer
4. Extract the directory tree structure as the target template
5. Present the extracted structure to the user for confirmation
6. If the reference project has a `CLAUDE.md` with DDD Architecture section, use its conventions

---

## Constraint Propagation: CLAUDE.md

### How It Works

```
ddd-init writes CLAUDE.md
    ↓
ddd-develop Phase 2 reads CLAUDE.md → generates plans following the structure
    ↓
ddd-audit D2 dimension reads CLAUDE.md → checks architecture compliance
```

### Rules

- If `CLAUDE.md` does not exist, create it with the DDD Architecture section
- If `CLAUDE.md` exists, append the DDD Architecture section (preserve existing content)
- If a DDD Architecture section already exists, replace it (update in place)
- The section is clearly marked with `> Generated by ddd-init` so it's identifiable

---

## Safety Mechanisms

| Mechanism | Purpose |
|-----------|---------|
| User confirmation before any file creation | No surprise directory changes |
| Refactor mode only creates roadmap, not moves files | Actual migration is controlled by ddd-develop |
| CLAUDE.md append (not overwrite) | Preserves existing project instructions |
| `.gitkeep` in empty dirs | Directories tracked by git without polluting with dummy files |
| --ref path validation | Verify reference project exists and has meaningful structure |

---

## Version & Metadata Changes

- **Version**: 1.6.0 → 1.7.0
- **plugin.json description**: Add "DDD project initialization" to description
- **Keywords**: Add "init", "scaffold"
- **README**: Document `/ddd-init` usage, templates, refactor mode
- **Pipeline diagram**: Update to show `ddd-init` as the entry point

## Built-in Template: fastlayer

**Tech Stack:** TypeScript / Next.js
**Reference:** https://github.com/RealMatrix-PTE-LTD/fastlayer

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

### Conventions

- Request flow: `Middleware → API Route → Handler → Service → BO → DAO → Database`
- Tuple return: `[data, error]` for all async functions
- Error handling: `ServiceError` objects, never `new Error()` for 4xx
- Type system: `DTO (API) ↔ Entity (Domain) ↔ PO (Database)`
- PO to Entity: `convertNullToUndefined<Entity>(po)`
- Entity to PO: `entity.field ?? null`
- Cross-module communication: via `app/internal/` interfaces
- Tests: colocated in `__tests__/` within each layer

### Standardized docs/ Structure

```
docs/
├── roadmap/                    # ddd-roadmap output
├── audit/                      # ddd-audit output
├── architecture/               # Architecture documentation
└── plans/                      # Implementation plans
```

---

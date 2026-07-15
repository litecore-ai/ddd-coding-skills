# Fastlayer Architecture Variant

Use this TypeScript/Next.js variant only after the user selects it and Node.js 20+ is available. Adapt it to the project's established language; do not impose names or error conventions that conflict with existing code.

## Bounded-context shape

```text
server/
├── handler/                    # Delivery adapters grouped by real consumer flow
├── infras/                     # Shared technical adapters
└── modules/
    └── <bounded-context>/
        ├── domain/             # Aggregates, entities, values, events, pure policies
        ├── app/                # Use-case orchestration and ports
        ├── repo/               # Persistence adapters and mappings
        ├── acl/                # External-system anti-corruption adapters
        └── tests/              # Unit, integration, consumer, and E2E evidence
```

Dependency direction:

```text
delivery → application → domain
persistence adapter → application/domain port
external adapter → application/domain port
domain → no framework, transport, storage, or network dependency
```

Create only directories needed by the first approved vertical slice. Do not scaffold empty ports, repositories, handlers, or models. The first slice must traverse a real handler or system consumer, application use case, domain rule, required adapter, and observable result.

## Canonical project state

```text
docs/
├── product-brief.md
├── architecture/
├── roadmap/
│   ├── roadmap.json            # Canonical
│   └── roadmap.md              # Generated view
├── specs/                      # Canonical JSON plus generated views
└── runs/                       # Immutable terminal reports
.ddd/
└── runs/                       # Local controller journals
```

Record bounded contexts, aggregate ownership, public contracts, transaction boundaries, real consumers, and test commands in the approved architecture/roadmap documents. Let `roadmapctl` validate state; never encode execution status in this template.

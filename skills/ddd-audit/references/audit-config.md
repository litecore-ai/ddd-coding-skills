## Audit Configuration

Projects can customize audit behavior via `.audit-config.yml` at project root.

### Configuration Schema

```yaml
# .audit-config.yml

# Dimension weights and toggles
dimensions:
  D1_design:      { enabled: true,  weight: 1.0 }
  D2_architecture: { enabled: true,  weight: 1.5 }  # DDD projects weight this higher
  D3_quality:     { enabled: true,  weight: 1.0 }
  D4_security:    { enabled: true,  weight: 2.0 }  # security-critical project
  D5_testing:     { enabled: true,  weight: 1.0 }
  D6_integration: { enabled: true,  weight: 1.0 }
  D7_performance: { enabled: false, weight: 0.0 }  # disable for internal tools
  D8_observability: { enabled: true, weight: 0.5 }

# DDD layer mapping (override auto-detection)
layers:
  domain:        ["src/domain", "src/core"]
  infrastructure: ["src/infra", "src/adapters"]
  application:   ["src/app", "src/usecases"]
  presentation:  ["src/web", "src/api", "src/cli"]
  crosscutting:  ["src/shared", "src/common"]

# Thresholds
thresholds:
  max_function_loc: 50
  max_file_loc: 800
  min_test_coverage: 80    # percent
  max_nesting_depth: 4

# Exclude paths from audit
exclude:
  - "src/generated/**"
  - "**/*.test.*"
  - "scripts/**"

# Output language override (auto | zh | en | bilingual)
language: auto
```

### Behavior

- If `.audit-config.yml` exists, load it in Step 1 (Project Scan)
- Disabled dimensions are skipped entirely (no checklist items generated)
- Custom layer mappings override auto-detection
- Weights affect the scoring formula (see "Audit Scoring" in SKILL.md)
- If no config exists, use defaults (all dimensions enabled, weight 1.0, auto-detect layers)

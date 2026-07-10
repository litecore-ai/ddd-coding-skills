## Audit Scoring

Provide a quantitative score per dimension and overall, enabling cross-audit progress tracking.

### Scoring Formula

For each dimension D:

```
raw_score(D) = 1 - (2×CRIT + 1.5×HIGH + 1×MED + 0.5×LOW) / total_checklist_items(D)
score(D) = clamp(raw_score(D), 0, 1) × 100
```

Overall weighted score:

```
overall = Σ(score(D) × weight(D)) / Σ(weight(D))
```

### Score Table in Final Report

Add to `audit-report.md`:

```
## Audit Score

| Dimension | Items | CRIT | HIGH | MED | LOW | Score | Δ vs Previous |
|-----------|-------|------|------|-----|-----|-------|---------------|
| D1 Design | 45 | 1 | 3 | 8 | 5 | 72% | +8% |
| D2 Architecture | 38 | 0 | 2 | 5 | 3 | 81% | +12% |
| ... | | | | | | | |
| **Overall (weighted)** | | | | | | **76%** | **+9%** |

### Score History
| Date | Overall | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 |
|------|---------|----|----|----|----|----|----|----|----|
| 2026-03-15 | 67% | 64% | 69% | ... |
| 2026-04-08 | 76% | 72% | 81% | ... |
```

### Score Interpretation

| Range | Label | Meaning |
|-------|-------|---------|
| 90-100% | Excellent | Production-ready, minor polish only |
| 75-89% | Good | Deployable with known issues tracked |
| 60-74% | Fair | Needs targeted fixes before production |
| 40-59% | Poor | Significant rework needed |
| 0-39% | Critical | Major architectural or security concerns |


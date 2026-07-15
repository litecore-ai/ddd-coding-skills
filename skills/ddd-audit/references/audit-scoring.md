## Non-gating Audit Scoring

Provide an optional presentation score per dimension and overall only when the user explicitly requests it. Render scores in the response after the normal findings; never create or update `audit-report.md`, controller evidence, score history, or any other file. Scores do not affect finding severity, attestation, or pass/fail truth.

### Scoring Formula

For each dimension D, begin at 100 and apply deterministic finding penalties:

```
score(D) = clamp(100 - 40×CRIT - 25×HIGH - 10×MEDIUM - 3×LOW, 0, 100)
```

Overall weighted score:

```
overall = Σ(score(D) × weight(D)) / Σ(weight(D))
```

Use the advisory weight from `.audit-config.yml` when present; otherwise use weight `1.0` for every dimension.

### Score Table in the Response

Add this table after the findings in the user-facing response:

```
## Audit Score

| Dimension | CRIT | HIGH | MEDIUM | LOW | Score |
|-----------|------|------|--------|-----|-------|
| D1 Design | 0 | 0 | 1 | 1 | 87% |
| D2 Architecture | 0 | 1 | 0 | 0 | 75% |
| ... | | | | | |
| **Overall (weighted)** | | | | | **81%** |
```

### Score Interpretation

| Range | Label | Meaning |
|-------|-------|---------|
| 90-100% | Low finding pressure | Few recorded deductions in this dimension |
| 75-89% | Moderate finding pressure | Recorded issues need review |
| 50-74% | High finding pressure | Significant findings are present |
| 0-49% | Severe finding pressure | Concentrated or high-severity findings are present |

Always display this caveat: the score summarizes recorded findings, not review coverage or deployment readiness. Any CRIT or HIGH finding remains blocking regardless of score.

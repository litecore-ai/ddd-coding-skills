# Read-only CI Consumption

CI may consume a controller-validated `ddd-audit/v1` result without giving the audit producer external write authority.

1. Resolve the same immutable baseline and implementation commits used by the roadmap run.
2. Run the audit in an isolated checkout and emit the exact JSON report at the controller-designated path.
3. Submit it through `roadmapctl attest`; treat controller rejection as a failed job.
4. Fail the job when normalized counts contain CRIT or HIGH. Surface MEDIUM and LOW in the job summary.
5. Retain the immutable controller run report as the provenance record.

The audit invocation remains read-only. Any later ticketing, review annotation, deployment decision, or other external action is a separate user-authorized workflow and must consume the validated report rather than expanding audit permissions.

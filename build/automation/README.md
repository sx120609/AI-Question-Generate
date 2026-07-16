# Automation Helpers

This folder contains reusable helpers for fully automated L2 production runs.

## Files

- `production_preflight.mjs` / `l2_protocol_extract.py` / `config/l2_production_protocol.json`  
  Every new run rereads the Feishu-sourced phase-two requirements snapshot and the other required production inputs, repairs the supplied workbook's incorrect `A1` dimension in read-only mode, samples exactly one reference per question from only the question and attachment-summary columns, and writes a hash-bound `production_input_packet.json`. Missing inputs block run creation.

- `production_trace_gate.mjs`  
  Validates the per-question structure breakdown, non-overlapping attachment set, exact first-gate result, language-only second gate, revision log, final 14 fields, punctuation/parentheses rules, candidate TSV and fill plan. V2 also requires an exact one-to-one row mapping and binds every real attachment's path, byte length, and SHA-256; post-gate attachment replacement invalidates the receipt.

- `production_pipeline_prompts.mjs`  
  Builds the six executable prompt stages bound to the sampled row: reference breakdown, attachment planning, question drafting, exact first quality gate, language-only second gate, and frozen final compilation. The second gate cannot be built before a clean first-gate pass.

- `production_workflow_state.mjs`  
  Persists the per-question state machine. It rejects skipped or out-of-order stages, records every QA attempt and repair, forces abandonment/resampling after two failed first-gate rounds, and exports the trace consumed by `production_trace_gate.mjs` only when every question is complete.

- `run_context.mjs`  
  Creates isolated run folders under `outputs/auto_runs`, writes manifests, manages lock directories under `outputs/locks`, and reserves Feishu rows under a sheet lock.

- `topic_registry.mjs`  
  Global topic registry and similarity guard. Use before research starts. If a candidate is too close to an active/submitted/accepted topic, reject it and choose a different topic.

- `structure_fingerprint.mjs` / `config/structural_diversity.json`  
  Extracts the non-topical shape of a record: question length and information coverage, opening mode, information order, decision and evidence forms, Word/Excel internal topology, normalized step actions, workflow topology, and sentence rhythm. Fixed format labels such as `docx, xlsx` are deliberately excluded from similarity scoring.

- `structure_gate.mjs`  
  Reserves source-driven run slots without assigning synthetic structure passports, then compares completed B/G/L/N/O content with the current batch and the global history registry. `FAIL` blocks immediately; `REVIEW` also blocks until an independent reviewer supplies a hash-bound `APPROVE`. Its structure receipt is one input to the combined release gate and cannot authorize a narrative submission by itself.

- `release_gate.mjs`  
  Revalidates the naturalness benchmark, scene-card/fact-ledger role consistency, candidate, fill plan, structure report, and any independent review signoffs, then emits the composite v2 release receipt required for narrative submission. Any post-gate edit or stale hash invalidates that receipt.

- `situated_generation.mjs`  
  Builds the hidden scene card and requester voice used inside the new question-draft stage. It keeps role/world state out of the Feishu question; it is no longer a substitute for reference sampling, attachment construction, or either QA gate.

- `scene_card.mjs`  
  Validates the finite-view requester protocol, request and role-trace spans, fact-ledger bindings, masked author-voice collisions, and emits a deterministic role-consistency report required by the release gate.

  Operational rules and commands: `docs/agent/STRUCTURAL_DIVERSITY_GATE.md`.

- `backfill_structure_registry.mjs`  
  Reads managed Shen Li/Pei Ying rows from Feishu A:P, deduplicates by UID, and stores legacy fingerprints in `outputs/auto_runs/_structure_registry.json`. Legacy rows are comparison baselines and are not silently rewritten.

- `qa_client.mjs`  
  Runs external QA links, parses status and feedback, classifies common issue types, and helps decide whether repeated feedback is a likely QA bug after at least three rounds.

- `feishu_openapi_client.mjs`  
  Small dependency-free Feishu OpenAPI client for resolving wiki sheet links, reading spreadsheet metadata, and writing batch cell ranges. Physical B/G/L/N/O writes require a v2 release receipt whose address, field, and value match exactly; M-only maintenance remains exempt. It can fall back to official `lark-cli` user identity when no direct token is configured.

- `feishu_lark_cli_client.mjs`  
  Wrapper around official `lark-cli`. It prefers a global binary and falls back to bundled `pnpm dlx @larksuite/cli@latest`, keeping JSON output usable for automation.

- `feishu_auth_setup.mjs`  
  Status/bootstrap/login helper for Feishu user identity. Use this before formal production to configure `lark-cli` and verify user authorization.

- `feishu_sheet_submit.mjs`  
  Converts `feishu_fill_plan_*.json` into Sheets `values_batch_update` payloads and a separate real-file attachment upload queue. Any B/G/L/N/O write must provide both a valid composite release receipt and the hash-bound production-trace receipt; a bare structure receipt or a run that skipped sampling/two-gate trace is rejected. Both receipts are rechecked after acquiring the sheet lock. Format-only maintenance such as an M-column migration remains independent. This is the preferred path for Feishu text/option fields; browser automation is only a fallback for J-column attachment objects.

- `product_format.mjs`  
  Defines the canonical product-format contract. The Feishu `产物格式` field contains lowercase extensions only, for example `docx, xlsx`; legacy verbose labels are normalized at the submission boundary.

- `generated_identities.mjs` / `config/generated_identities.json`  
  Persist the identities generated and maintained by this project. The current managed identities are `沈礼` and `裴硬`; bulk maintenance matches by annotator name, UID prefix, or known run ID.

- `migrate_product_formats.mjs`  
  Audits or updates the Feishu M column for all managed generated identities, then performs a full readback verification. Dry-run is the default; use `--apply` for an authorized migration.

## Rule

Automated runs must write intermediate artifacts only under their own `outputs/auto_runs/<run_id>` directory. Shared files and Feishu rows require locks.

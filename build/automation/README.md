# Automation Helpers

This folder contains reusable helpers for fully automated production runs. `l1` is the default phase-three profile; `l2` remains available through an explicit profile flag.

Before starting any new production run, read `docs/agent/SOURCE_DERIVED_QUESTION_BASELINE.md`. Its source-first and no-fabrication rules are inherited from L2 and apply to every production profile.

## Files

- `production_profile.mjs` / `production_preflight.mjs` / `l2_protocol_extract.py`
  `production_profile.mjs` defines the L1 default and historical L2 contract. The extractor name is retained for compatibility, but it now accepts `--profile=l1|l2`. L1 samples from the curated phase-three JSON corpus, while L2 retains the supplied workbook repair and sampling path. Both write a hash-bound `production_input_packet.json`; missing inputs block run creation.

- `l1_naturalness_baseline.mjs`
  Builds a run-local naturalness baseline from the five retained phase-three L1 examples, so shorter L1 prompts are not judged against the historical L2 corpus.

- `production_trace_gate.mjs`
  Validates the per-question structure breakdown, non-overlapping attachment set, exact first-gate result, language-only second gate, revision log, final 14 fields, punctuation/parentheses rules, candidate TSV and fill plan. V2 also requires an exact one-to-one row mapping and binds every real attachment's path, byte length, and SHA-256; post-gate attachment replacement invalidates the receipt.

- `production_pipeline_prompts.mjs`
  Builds the six executable prompt stages bound to the sampled row: reference breakdown, attachment planning, question drafting, exact first quality gate, language-only second gate, and frozen final compilation. The second gate cannot be built before a clean first-gate pass.

- `domestic_work_scope.mjs`
  Fail-closed scope gate for the default domestic audience. It blocks foreign platforms, domestic sensitive topics, non-work follow-ups, and calculation tasks with fewer than two real complexity dimensions. Generation, both quality gates, Mugua rewriting, and Doubao outbound interaction all call the same policy version.

- `openai_responses.mjs` / `production_model_client.mjs`
  Shared official-compatible Responses adapter for custom API gateways. Set `CODEX_RESPONSES_API_KEY`, `CODEX_RESPONSES_BASE_URL`, `CODEX_RESPONSES_MODEL=gpt-5.6-sol`, and `CODEX_RESPONSES_REASONING_EFFORT=high`. The base URL may be a gateway root, a `/v1` root, or the full `/v1/responses` endpoint. Structured output is sent through `text.format` with a strict JSON Schema. Every successful call records provider-returned input, cached-input, output, reasoning, visible-output, total-token, response-ID, request-ID, and model fields; missing official `usage` data fails closed instead of estimating. Credentials are never written to receipts.

- `produce_l1_single_task.mjs`
  End-to-end single-task producer. Its behavior-preserving default remains the locally logged-in Codex CLI. Select the custom Responses route with `--codex-backend=responses-api`; production-stage receipts are aggregated into `qa/codex_usage_summary.json`, and the generated Doubao job carries the same backend into prompt preflight and interaction planning. The interaction result exposes its own `codexUsageSummary` so exact production and interaction totals remain separately auditable.

- `l1_async_pipeline.mjs` / `run_l1_async_pipeline.mjs`
  Producer-consumer coordinator for isolated L1 batches. Production workers run independently and enqueue each immutable job package immediately after it passes production; they do not wait for slower producers or for a free Doubao window. Up to three target-bound interaction workers consume concurrently, while overflow remains durable in `pending`. Interrupted jobs retain their original `targetId`, and target-bound resumes take priority over ordinary warehouse work so a newer job cannot overwrite the resumable conversation. A fresh interaction may send only after the worker proves that the new Office Task is blank. Any recovery prompt/attachment mismatch abandons the old conversation and requeues the immutable task from round one; it never resends into the mismatched conversation. A quota reply pauses every window and every new model attempt; waits within 24 hours resume at the advertised time plus one minute, while longer or unparseable waits persist `paused_quota_wait`, mark the batch `paused-quota`, and exit. A per-batch coordinator lock rejects duplicate live coordinators. Use `doubao-automation/src/cli.mjs resume-quota` before `--resume-batch --recover-running` after a durable quota stop; API keys remain environment-only.

- `build-development-package.ps1`
  Builds the source-only developer ZIP. It includes controlled source, tests, documentation, configs, and inputs, but excludes outputs, temporary runs, Git/Codex metadata, dependencies, portable runtimes, environment files, and runtime secrets. The staging tree is scanned for credential-like material before compression; successful builds emit a ZIP, SHA-256 file, and manifest under `dist/`.

- `production_generation_runner.mjs` / `two_quality_gate_runner.mjs`
  Execute the generation stages and the exact two quality gates through `production_model_client.mjs`, write hash-bound raw model responses, and record the selected provider and model in their execution receipts. L1 skips the historical L2-only continuity-model call.

- `openai_compatible_chat.mjs`
  Low-level Chat Completions adapter retained for the explicitly selected third-party model route and historical replay scripts. It is not the default L1 generation or quality client.

- `mugua_de_ai_rewrite_client.mjs`
  Default B-column de-AI client. It sends the frozen prompt plus current question directly to Mugua's OpenAI-compatible Chat Completions endpoint with `gemini-3.1-pro-preview`, parses strict JSON, and returns prompt/model/usage provenance without the credential. `de_ai_rewrite_client.mjs` remains only for replaying historical `/api/rewrite` runs.

- `claude_question_rewriter.mjs`
  Sends only the current B-column question through the Mugua de-AI client, synthesizes validation sidecars locally from the returned text, and automatically makes up to three content attempts (`DE_AI_REWRITE_CONTENT_ATTEMPTS`) before selecting a safe passing result. If none passes, it retains diagnostics and exits nonzero, so fact drift, excessive similarity, invalid request spans, missing formats, or other findings cannot continue to submission. The old Claude-named exports remain compatibility aliases; generation and both quality gates use the separate Codex-model route above.

- `production_workflow_state.mjs`
  Persists the per-question state machine. It rejects skipped or out-of-order stages, records every QA attempt and repair, forces abandonment/resampling after two failed first-gate rounds, and exports the trace consumed by `production_trace_gate.mjs` only when every question is complete. L1 keeps its optional product-format field but now inherits the current L2 attachment hard standard: at least one real attachment, at least 80% specific-business evidence, and a verified object-level source.

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
  Converts `feishu_fill_plan_*.json` into Sheets `values_batch_update` payloads and a separate real-file attachment upload queue. Any B/G/L/N/O write must provide both a valid composite release receipt and the hash-bound production-trace receipt; a bare structure receipt or a run that skipped sampling/two-gate trace is rejected. Both receipts are rechecked after acquiring the sheet lock. L1 callers pass `--policy=config/structural_diversity_l1.json` and the L1 structure registry so validation and registration use the same policy. Format-only maintenance such as an M-column migration remains independent. This is the preferred path for Feishu text/option fields; browser automation is only a fallback for J-column attachment objects.

- `product_format.mjs`
  Defines the canonical product-format contract. The Feishu `产物格式` field contains lowercase extensions only, for example `docx, xlsx`; legacy verbose labels are normalized at the submission boundary.

- `generated_identities.mjs` / `config/generated_identities.json`
  Persist the identities generated and maintained by this project. The current managed identities are `沈礼` and `裴硬`; bulk maintenance matches by annotator name, UID prefix, or known run ID.

- `migrate_product_formats.mjs`
  Audits or updates the Feishu M column for all managed generated identities, then performs a full readback verification. Dry-run is the default; use `--apply` for an authorized migration.

## Rule

Automated runs must write intermediate artifacts only under their own `outputs/auto_runs/<run_id>` directory. Shared files and Feishu rows require locks.

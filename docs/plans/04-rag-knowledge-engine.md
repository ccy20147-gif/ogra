# 04 RAG and Knowledge Engine

> Layer: local knowledge ingestion and retrieval
>
> Phase coverage: Alpha required, Beta/v1 extensions noted
>
> Depends on: [02 Local Data, Audit, and Governance Store](02-local-data-audit-governance-store.md), [03 Policy, Routing, and Safety Engine](03-policy-routing-safety-engine.md)

## 1. Goal

Build Ogra's local knowledge engine as a first-class product surface, not a hidden chat attachment.

The RAG engine must let users import private folders, classify them, index them locally, retrieve relevant context, and see exactly which sources influenced a run and whether those sources entered cloud context.

## 2. Alpha Scope

Alpha MUST support:

- user-selected folder import.
- Markdown files.
- TXT files.
- common code files.
- manual reindex.
- SQLite FTS5 retrieval.
- file and chunk classification inheritance.
- citation display in answers.
- indexing status and error reporting.
- local-only retrieval for Confidential and Restricted data.

Alpha MAY include:

- simple local sensitive-pattern detector that can only raise classification, not lower it.
- basic parser warnings for unsupported/binary files.

Alpha MUST NOT include:

- PDF/OCR as a required capability.
- automatic cloud embedding for private content.
- background deletion sync as a required capability.
- Notion/Google Drive/Feishu connectors.

## 3. Import Flow

The import flow MUST require:

1. user chooses folder through desktop picker.
2. Ogra records approved root after canonical path validation.
3. user selects workspace.
4. user selects folder classification.
5. Ogra previews included file types and excluded files.
6. user confirms import.
7. indexing job starts and emits progress.

Classification choices MUST include:

- Public.
- Internal.
- Confidential.
- Restricted.

Unknown or skipped classification MUST NOT become Public silently.

## 4. File Discovery

Alpha MUST support a configurable allowlist:

- `.md`, `.markdown`
- `.txt`
- `.js`, `.jsx`, `.ts`, `.tsx`
- `.py`, `.go`, `.rs`, `.java`, `.kt`
- `.c`, `.cpp`, `.h`, `.hpp`
- `.json`, `.yaml`, `.yml`, `.toml`
- `.sql`, `.sh`

Alpha MUST ignore by default:

- hidden folders such as `.git`.
- dependency folders such as `node_modules`.
- build outputs such as `dist`, `build`, `.next`.
- binary files.
- files above a configured size threshold.

Ignored files MUST be counted and explainable in indexing status.

## 5. Parsing and Chunking

Each parsed document MUST produce:

- content hash.
- parser version.
- chunker version.
- UTF-8 byte offsets.
- line start and line end for Markdown, TXT, and code files.
- classification snapshot.
- source trust level.
- instructional content flag when suspicious prompt-injection patterns appear.

Alpha chunking MAY be simple, but it MUST preserve document ids, content hash, byte offsets, and line ranges. Citations MUST resolve against the indexed content hash, not blindly against a later changed file.

Code files SHOULD be chunked by stable boundaries when feasible:

- headings for Markdown.
- paragraphs for text.
- line ranges for code.

## 6. Indexing Jobs

Indexing MUST run as a cancellable job.

Indexing status MUST include:

- queued/running/succeeded/failed/cancelled.
- files discovered.
- files indexed.
- files skipped.
- chunks indexed.
- warnings.
- errors.
- started/completed timestamps.

Indexing progress events MUST NOT include raw file contents. They MAY include file names, counts, hashes, and warning ids.

Manual reindex MUST:

- update changed content by content hash.
- preserve audit evidence for previous runs.
- create an audit event.

Alpha MAY reindex a whole knowledge base instead of incremental file-level updates, as long as status is clear.

## 7. Retrieval

Retrieval MUST:

- accept workspace scope.
- accept knowledge base scope when selected.
- run retrieval policy before search to determine what data can be accessed.
- query only allowed documents/chunks.
- return chunk ids, document ids, file names, snippets, offsets, classification, and retrieval method.
- mark whether each retrieved chunk is allowed for local context, cloud context, or blocked.
- write `document_access_events` and `run_context_sources` records for retrieved, selected, local_context, cloud_context, redacted, blocked, and excluded lifecycle states.

Alpha retrieval method:

- `fts`.

Beta MAY add:

- local embeddings.
- hybrid retrieval.

Cloud embedding MUST NOT be used for Internal, Confidential, or Restricted data unless policy explicitly allows and required approval/redaction steps are completed.

## 8. Context Assembly

Context assembly MUST:

- run context policy before adding chunks to prompt context.
- compute high-water classification.
- wrap retrieved content as untrusted quoted context.
- include citation ids.
- include source labels in prompt metadata.
- exclude blocked chunks.

Model invocation MUST run model/payload policy after context assembly and before any adapter call. Retrieval policy, context policy, and model/payload policy MUST be separate checks because they answer different questions:

- retrieval policy: may this run access this source?
- context policy: may this source enter any prompt?
- model/payload policy: may this assembled context enter the selected local/cloud adapter?

The assembled prompt MUST separate:

- system/developer/policy instructions.
- user request.
- retrieved untrusted context.
- citation metadata.

## 9. Citation Output

Every RAG answer MUST expose:

- referenced file.
- referenced snippet.
- line range or source offset when available.
- retrieval method.
- data classification.
- whether the source entered local context, cloud context, or neither.
- lifecycle state from `run_context_sources`: retrieved, selected, local_context, redacted, cloud_context, blocked, or excluded.

If no source is retrieved, UI MUST say that no local source was used.

## 10. Prompt Injection Handling

The RAG engine MUST flag suspicious imported content using deterministic patterns.

Flagged chunks:

- remain searchable.
- carry `instructional_content_detected`.
- increase run risk when retrieved.
- cannot trigger tools or route changes by themselves.
- must be shown with warnings in route trace/governance views.
- must write `prompt_injection_warning` events with chunk id, pattern id, detector version, and evidence hash when retrieved into a run.
- must create or update run risk reasons.

If a flagged chunk would enter cloud context, Alpha MUST block or route local unless a later phase implements a complete approval and redaction flow.

## 11. Data Safety Integration

Data Safety Center MUST be able to show:

- knowledge base list.
- root path display with privacy-conscious truncation.
- classification.
- inheritance source.
- indexing status.
- file and chunk counts by classification.
- recent access.
- recent cloud-context inclusion.
- associated policies.
- allowed agents/models.

These views MUST be backed by structured retrieval/context/model evidence, not by LLM-generated citations alone.

## 12. Classification Changes

Classification precedence MUST be:

1. Restricted/Confidential user override.
2. explicit file classification.
3. folder/knowledge base classification.
4. workspace default classification.
5. local detector raise.
6. policy runtime raise.

When a user changes knowledge base or file classification:

- future retrieval and context assembly MUST use the new effective classification.
- existing run evidence MUST retain the historical classification snapshot.
- chunks SHOULD be reindexed or metadata-updated before the new classification is considered complete.
- downgrade from higher sensitivity to lower sensitivity SHOULD require explicit confirmation and audit event.

## 13. Knowledge UI Requirements

Alpha Knowledge UI MUST include:

- import wizard.
- indexing job list.
- file and classification browser.
- chunk/citation inspector.
- retrieval test panel.
- reindex controls.
- prompt-injection warning list.
- recent retrieval drilldown.
- Data Safety Center entry point for the selected source.

## 14. Beta Requirements

Beta SHOULD add:

- PDF evaluation.
- automatic incremental indexing.
- deletion detection and tombstone records.
- local embedding adapter.
- vector index metadata.
- user-visible source trust management.
- richer sensitive detector.

## 15. Acceptance Criteria

Alpha is accepted when:

- A user can import a folder, mark it Confidential, and manually index it.
- Unsupported files are skipped with visible reasons.
- FTS5 retrieval returns source-linked chunks.
- Retrieved Confidential chunks force local-only route.
- RAG answer UI shows citations with classification and cloud-context status.
- `run_context_sources` proves retrieved/selected/local/cloud/blocked state for every cited source.
- Prompt injection fixture content creates warnings and run risk entries.
- Indexing and reindexing write audit events.
- Knowledge UI supports import, file/classification browsing, chunk inspection, retrieval test, warnings, and reindex controls.
- No raw file contents are emitted through progress events.
- Tests cover Markdown, TXT, code files, skipped files, classification inheritance, source offsets, and high-water retrieval behavior.

## 16. Anti-Patterns

MUST NOT introduce:

- context assembly without policy checks.
- citations generated only from LLM text.
- file paths shown without user privacy consideration.
- cloud embeddings as default.
- chunk rows without source offsets.
- prompt-injection warnings that exist only in UI state.
- silent fallback to cloud search.

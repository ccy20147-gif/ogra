import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * Database migration system for Ogra Desktop.
 *
 * Applies schema migrations in order and tracks version in a meta table.
 */
export class OgraDatabase {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(appDataDir: string) {
    this.dbPath = path.join(appDataDir, 'ogra.db');
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  getDB(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  runMigrations(): void {
    // Create meta table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const currentVersion = this.getCurrentVersion();

    const migrations = this.getMigrations().filter(m => m.version > currentVersion);
    for (const migration of migrations) {
      this.db.transaction(() => {
        // P1 fix: migrations may need a JS-driven preflight before
        // running their SQL (because SQLite lacks ADD COLUMN IF
        // NOT EXISTS). The preflight hook is keyed by version and
        // runs INSIDE the same transaction as the SQL.
        if (migration.preflight) {
          migration.preflight(this.db);
        }
        this.db.exec(migration.sql);
        this.db.prepare(
          'INSERT INTO _migrations (version, name) VALUES (?, ?)'
        ).run(migration.version, migration.name);
      })();
    }
  }

  private getCurrentVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) as version FROM _migrations').get() as { version: number | null };
    return row?.version ?? 0;
  }

  private getMigrations(): Array<{
    version: number; name: string; sql: string;
    preflight?: (db: any) => void;
  }> {
    return [
      {
        version: 1,
        name: 'initial-schema',
        sql: this.getInitialSchema(),
      },
      {
        version: 2,
        name: 'm3-memory-and-agent-group',
        sql: this.getM3Schema(),
      },
      {
        version: 3,
        name: 'agents-and-secrets',
        sql: this.getV3Schema(),
      },
      {
        version: 4,
        name: 'chunk-line-metadata',
        sql: this.getV4Schema(),
      },
      {
        version: 5,
        name: 'fk-constraints',
        sql: this.getV5Schema(),
      },
      {
        version: 6,
        name: 'cleanup-legacy-memories',
        sql: this.getV6Schema(),
      },
      {
        version: 7,
        name: 'memory-fts5-indexes',
        sql: this.getV7Schema(),
      },
      {
        version: 8,
        name: 'content-hash-index',
        sql: this.getV8Schema(),
      },
      {
        version: 9,
        name: 'agent-runs-fk-constraints',
        sql: this.getV9Schema(),
      },
      {
        version: 10,
        name: 'approvals-workspace-and-scope',
        sql: this.getV10Schema(),
      },
      {
        version: 11,
        name: 'agent-runs-final-output-and-error',
        sql: this.getV11Schema(),
      },
      {
        version: 12,
        name: 'route-redact-then-egress',
        sql: this.getV12Schema(),
      },
      {
        version: 13,
        name: 'egress-records',
        sql: this.getV13Schema(),
      },
      {
        version: 14,
        name: 'model-calls-add-fields',
        sql: this.getV14Schema(),
      },
      {
        version: 15,
        name: 'approvals-revision-and-binding-fields',
        sql: this.getV15Schema(),
      },
      {
        version: 16,
        name: 'model-calls-http-body-hash',
        sql: this.getV16Schema(),
        preflight: (db: any) => {
          // P1 fix: an existing v15 database lacks this column.
          // SQLite ALTER TABLE throws "duplicate column" if it
          // already exists, so we MUST detect first and conditionally
          // ALTER. We check via pragma_table_info and run the ALTER
          // inside the same transaction as the migration version row
          // — so if the ALTER fails, the version is not committed.
          const has = db.prepare(
            `SELECT COUNT(*) AS c FROM pragma_table_info('model_calls')
              WHERE name = 'http_body_hash'`,
          ).get() as { c: number };
          if (has.c === 0) {
            db.exec('ALTER TABLE model_calls ADD COLUMN http_body_hash TEXT;');
          }
        },
      },
      {
        version: 17,
        name: 'approvals-sanitized-preview-evidence',
        sql: this.getV17Schema(),
        preflight: (db: any) => {
          const table = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approvals'",
          ).get();
          // Some migration fixtures deliberately model only the table
          // under test. A real v16 installation always has approvals,
          // but do not make a partial recovery database unopenable.
          if (!table) return;
          const columns = db.prepare("SELECT name FROM pragma_table_info('approvals')").all() as Array<{ name: string }>;
          const names = new Set(columns.map(column => column.name));
          if (!names.has('sanitized_preview')) {
            db.exec('ALTER TABLE approvals ADD COLUMN sanitized_preview TEXT;');
          }
          if (!names.has('redaction_rule_version')) {
            db.exec('ALTER TABLE approvals ADD COLUMN redaction_rule_version TEXT;');
          }
          db.exec('CREATE INDEX IF NOT EXISTS idx_approvals_run_decision ON approvals(run_id, decision);');
        },
      },
      // Sequence 1A Milestone 0: durable runtime kernel.
      // v18 adds hash_envelope_version on run_events (canonical v2
      // envelope) plus all frame/effect/receipt/binding/repair/lease/
      // audit_edges/tool_registry tables. Append-only: never alters
      // or rewrites a previously shipped migration.
      {
        version: 18,
        name: 'durable-runtime-kernel-m0',
        sql: this.getV18Schema(),
        preflight: (db: any) => {
          // run_events.hash_envelope_version is the discriminator
          // between legacy (v1) and canonical-envelope (v2) rows.
          // Pre-v18 rows are v1; new rows may carry either version
          // depending on the producer's envelope choice.
          const cols = db.prepare(
            "SELECT name FROM pragma_table_info('run_events')",
          ).all() as Array<{ name: string }>;
          const names = new Set(cols.map(c => c.name));
          if (!names.has('hash_envelope_version')) {
            db.exec(
              'ALTER TABLE run_events ADD COLUMN hash_envelope_version TEXT;',
            );
          }
          if (!names.has('frame_id')) {
            db.exec('ALTER TABLE run_events ADD COLUMN frame_id TEXT;');
          }
          if (!names.has('effect_id')) {
            db.exec('ALTER TABLE run_events ADD COLUMN effect_id TEXT;');
          }
          if (!names.has('repair_transaction_id')) {
            db.exec(
              'ALTER TABLE run_events ADD COLUMN repair_transaction_id TEXT;',
            );
          }
          if (!names.has('caused_by_event_id')) {
            db.exec(
              'ALTER TABLE run_events ADD COLUMN caused_by_event_id TEXT;',
            );
          }
          if (!names.has('idempotency_key_hash')) {
            db.exec(
              'ALTER TABLE run_events ADD COLUMN idempotency_key_hash TEXT;',
            );
          }
          if (!names.has('external_receipt_hash')) {
            db.exec(
              'ALTER TABLE run_events ADD COLUMN external_receipt_hash TEXT;',
            );
          }
          if (!names.has('target_subtree_revision')) {
            db.exec(
              'ALTER TABLE run_events ADD COLUMN target_subtree_revision INTEGER;',
            );
          }
        },
      },
    ];
  }

  private getV17Schema(): string {
    return `
      SELECT 1;
    `;
  }

  private getV18Schema(): string {
    // Sequence 1A Milestone 0: durable runtime kernel tables.
    // All tables are append-only here. Constraints carry the
    // primary invariants from plan 10 §3-§6 and plan 11 §5/§6:
    // - one receipt row per (effect_id, attempt_no) — never overwritten
    // - one approval binding per (effect_id, callback_attempt_no)
    // - one repair step per (transaction_id, step_index)
    // - one audit edge per (from_kind, from_id, relation, to_kind, to_id)
    // - an idempotency_key_hash denotes one logical effect globally
    return `
      -- Execution Frames
      CREATE TABLE IF NOT EXISTS run_frames (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        parent_frame_id TEXT REFERENCES run_frames(id),
        run_step_id TEXT,
        frame_kind TEXT NOT NULL CHECK(frame_kind IN
          ('root','plan_step','react','repair','synthesis')),
        status TEXT NOT NULL CHECK(status IN
          ('pending','running','awaiting_approval','completed',
           'failed','cancelled')),
        path_json TEXT NOT NULL DEFAULT '[]',
        node_revision INTEGER NOT NULL DEFAULT 1,
        subtree_revision INTEGER NOT NULL DEFAULT 1,
        input_hash TEXT,
        output_hash TEXT,
        created_event_id TEXT,
        terminal_event_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_frames_run_status
        ON run_frames(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_frames_parent
        ON run_frames(parent_frame_id);
      -- A run has exactly one execution root. Child frames use a
      -- non-NULL parent_frame_id, so this partial index does not
      -- constrain their fan-out.
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_root_frame_per_run
        ON run_frames(run_id) WHERE parent_frame_id IS NULL;

      -- Effect Ledger
      CREATE TABLE IF NOT EXISTS run_effects (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        owner_frame_id TEXT NOT NULL REFERENCES run_frames(id),
        effect_type TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        callback_capsule_ref TEXT,
        callback_capsule_hash TEXT,
        callback_capsule_format_version TEXT,
        idempotency_key_ref TEXT,
        idempotency_key_hash TEXT,
        state TEXT NOT NULL CHECK(state IN (
          'planned','in_flight','unknown','received','committed',
          'quarantined','compensating','compensated','failed',
          'cancelled_before_send')),
        allowed_repair_actions_json TEXT NOT NULL DEFAULT '[]',
        dependency_effect_ids_json TEXT NOT NULL DEFAULT '[]',
        effect_revision INTEGER NOT NULL DEFAULT 1,
        route_decision_id TEXT,
        policy_evaluation_id TEXT,
        current_approval_id TEXT,
        egress_record_id TEXT,
        ingress_finding_id TEXT,
        external_request_id TEXT,
        authoritative_receipt_id TEXT,
        external_receipt_hash TEXT,
        created_event_id TEXT,
        terminal_event_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_effects_run_state
        ON run_effects(run_id, state);
      CREATE INDEX IF NOT EXISTS idx_effects_owner_frame
        ON run_effects(owner_frame_id);
      -- An idempotency key identifies one logical external effect. It
      -- MUST NOT be rebound to a different frame, payload, or run.
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_effects_idem_hash
        ON run_effects(idempotency_key_hash)
        WHERE idempotency_key_hash IS NOT NULL;

      -- Effect Receipts: callback attempt vs physical application evidence
      CREATE TABLE IF NOT EXISTS effect_receipts (
        id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL REFERENCES run_effects(id) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL,
        request_id TEXT,
        request_hash TEXT,
        response_hash TEXT,
        result_capsule_ref TEXT,
        result_capsule_hash TEXT,
        result_capsule_format_version TEXT,
        provider_status TEXT,
        application_status TEXT NOT NULL CHECK(application_status IN
          ('not_applied','applied','unknown')),
        receipt_hash TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        event_id TEXT,
        UNIQUE(effect_id, attempt_no)
      );

      -- Per-attempt immutable approval lineage
      CREATE TABLE IF NOT EXISTS effect_approval_bindings (
        id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL REFERENCES run_effects(id) ON DELETE CASCADE,
        callback_attempt_no INTEGER NOT NULL,
        approval_id TEXT NOT NULL,
        approval_revision INTEGER NOT NULL,
        binding_kind TEXT NOT NULL CHECK(binding_kind IN
          ('initial','recovery_retry')),
        created_event_id TEXT,
        UNIQUE(effect_id, callback_attempt_no)
      );

      -- Approval consumptions: counter rows consumed atomically
      -- before callback (plan 02 §3.4)
      CREATE TABLE IF NOT EXISTS approval_consumptions (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        effect_id TEXT NOT NULL,
        callback_attempt_no INTEGER NOT NULL,
        approval_revision INTEGER NOT NULL,
        consumed_at TEXT NOT NULL DEFAULT (datetime('now')),
        event_id TEXT,
        UNIQUE(approval_id, effect_id, callback_attempt_no)
      );

      -- Repair transactions and steps (plan 10 §3.3)
      CREATE TABLE IF NOT EXISTS repair_transactions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        target_frame_id TEXT NOT NULL REFERENCES run_frames(id),
        target_subtree_revision INTEGER NOT NULL,
        authorized_effect_revisions_json TEXT NOT NULL DEFAULT '[]',
        proposed_plan_json TEXT NOT NULL DEFAULT '[]',
        verification_result_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN
          ('open','accepted','rejected','committed','aborted')),
        rejection_reason TEXT,
        created_event_id TEXT,
        terminal_event_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_repair_run_status
        ON repair_transactions(run_id, status);

      CREATE TABLE IF NOT EXISTS repair_steps (
        id TEXT PRIMARY KEY,
        repair_transaction_id TEXT NOT NULL REFERENCES repair_transactions(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        effect_id TEXT NOT NULL REFERENCES run_effects(id),
        action TEXT NOT NULL CHECK(action IN
          ('retry','compensate','preserve','amend','reconcile','escalate')),
        status TEXT NOT NULL,
        outcome_hash TEXT,
        event_id TEXT,
        UNIQUE(repair_transaction_id, step_index)
      );

      -- Recovery Lease (plan 10 §3.4): single local holder
      CREATE TABLE IF NOT EXISTS recovery_leases (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        holder_id TEXT NOT NULL,
        lease_version INTEGER NOT NULL DEFAULT 1,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        renewed_at TEXT NOT NULL DEFAULT (datetime('now')),
        released_at TEXT,
        last_event_id TEXT
      );

      -- Audit Edges (plan 10 §6): bidirectional rebuildable index.
      -- Distinct from run_events; an edge projection over L0+L1.
      CREATE TABLE IF NOT EXISTS audit_edges (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        from_kind TEXT NOT NULL CHECK(from_kind IN
          ('run','frame','effect','repair','memory','event')),
        from_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        to_kind TEXT NOT NULL CHECK(to_kind IN
          ('run','frame','effect','repair','route','policy','approval',
           'egress','ingress','receipt','memory','event')),
        to_id TEXT NOT NULL,
        source_event_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(from_kind, from_id, relation, to_kind, to_id)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_run ON audit_edges(run_id);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON audit_edges(from_kind, from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON audit_edges(to_kind, to_id);

      -- Tool Descriptor / Version / Workspace Binding (plan 11 §5/§6).
      -- T1 boundary: register immutable contracts, do not enable
      -- any transport or actual callback.
      CREATE TABLE IF NOT EXISTS tool_descriptors (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL CHECK(source_kind IN
          ('builtin','skill','mcp')),
        source_ref TEXT NOT NULL,
        logical_name TEXT NOT NULL,
        owner TEXT NOT NULL,
        latest_version_id TEXT,
        lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN
          ('discovered','pending_review','enabled','stale','revoked')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_tool_descriptor_sourceref
        ON tool_descriptors(source_kind, source_ref, logical_name);

      CREATE TABLE IF NOT EXISTS tool_versions (
        id TEXT PRIMARY KEY,
        descriptor_id TEXT NOT NULL REFERENCES tool_descriptors(id) ON DELETE CASCADE,
        source_version TEXT NOT NULL,
        descriptor_hash TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,
        input_schema_hash TEXT NOT NULL,
        output_schema_json TEXT,
        output_schema_hash TEXT,
        effect_class TEXT NOT NULL CHECK(effect_class IN
          ('read_only','local_mutation','external_mutation')),
        permissions_json TEXT NOT NULL DEFAULT '{}',
        data_compatibility_json TEXT NOT NULL DEFAULT '{}',
        recovery_capabilities_json TEXT NOT NULL DEFAULT '{}',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN
          ('discovered','pending_review','enabled','stale','revoked')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_tool_versions
        ON tool_versions(descriptor_id, source_version);

      CREATE TABLE IF NOT EXISTS workspace_tool_bindings (
        id TEXT PRIMARY KEY,
        logical_binding_id TEXT NOT NULL,
        parent_binding_id TEXT REFERENCES workspace_tool_bindings(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        tool_version_id TEXT NOT NULL REFERENCES tool_versions(id),
        revision INTEGER NOT NULL DEFAULT 1,
        binding_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        policy_id TEXT,
        approval_mode TEXT NOT NULL CHECK(approval_mode IN
          ('none','allowlist','each_call','workflow_step','administrative')),
        constraints_json TEXT NOT NULL DEFAULT '{}',
        auth_binding_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(workspace_id, logical_binding_id, revision)
      );
    `;
  }

  private getV16Schema(): string {
    // Sequence 0 v16: persist the hash of the actual HTTP body
    // (sha256 of the JSON sent to the provider's HTTP endpoint) so
    // the audit chain can verify which bytes actually left the
    // machine.
    //
    // Fresh databases (created after this migration was added to
    // initial schema) already have the column. Older databases
    // upgraded from v15 need the column added. SQLite ALTER TABLE
    // throws "duplicate column" if it exists, so we conditionally
    // add it by querying pragma_table_info. The driver throws if
    // http_body_hash is missing on a v15 upgrade, so we MUST
    // upgrade existing databases or storeModelCall() fails.
    //
    // Implementation: a CTE picks whether the ALTER is needed.
    // SQLite parses this as a single statement, executes it
    // exactly once, then we run a follow-up statement that does
    // the actual DDL. db.exec() supports multiple statements
    // separated by `;`.
    return `
      -- Conditional ALTER: SQLite 3.35+ supports ALTER TABLE
      -- ... ADD COLUMN IF NOT EXISTS, but our embedded version
      -- (which ships with most node-sqlite3 builds) does not.
      -- Use a guarded approach via the _v16_pending table.
      CREATE TABLE IF NOT EXISTS _v16_pending (k TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO _v16_pending (k) VALUES ('add_http_body_hash');
      -- recopy to a temp table only if column missing
      INSERT INTO _v16_pending (k)
        SELECT 'add_http_body_hash' WHERE NOT EXISTS (
          SELECT 1 FROM pragma_table_info('model_calls')
          WHERE name = 'http_body_hash'
        );
      -- Now we can't conditionally ALTER inside SQL only; we
      -- must do it from JS. Detect here via a sentinel row that
      -- means "the column is missing and must be added by JS".
      DELETE FROM _v16_pending WHERE k = 'add_http_body_hash'
        AND EXISTS (
          SELECT 1 FROM pragma_table_info('model_calls')
          WHERE name = 'http_body_hash'
        );
    `;
  }

  private getV15Schema(): string {
    // Sequence 0 v15: Approval row schema upgrade.
    //
    // Earlier databases that applied v10 BEFORE revision was added
    // would now lack `approvals.revision`. This migration adds:
    //  - revision (default 1; every approved decision increments it)
    //  - the NOT NULL constraint is enforced at the application
    //    layer because SQLite ALTER ADD COLUMN does not easily
    //    migrate existing NULL rows in older databases.
    //
    // Bindings locked at requestApproval() time:
    //  - policy_version_hash (mandatory non-null for new approvals)
    //  - payload_fingerprint (mandatory non-null for new approvals)
    //  - requested_scope_json already exists in v1
    //
    // We do NOT alter v10 retroactively because migrations must be
    // append-only; older databases rely on v15 to bring revisions in.
    return `
      ALTER TABLE approvals ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      -- Older rows may have NULL policy_version_hash / payload_fingerprint;
      -- we leave them NULL here and gate writes in RunService so
      -- loadApproval can strict-compare without NULL wildcard drift.
      UPDATE approvals SET policy_version_hash = 'legacy-no-policy-hash' WHERE policy_version_hash IS NULL;
      UPDATE approvals SET payload_fingerprint = 'legacy-no-payload-fingerprint' WHERE payload_fingerprint IS NULL;
    `;
  }

  private getV14Schema(): string {
    // Sequence 0: Real Canonical Model Call evidence: agent must
    // persist the canonical model id (from ProviderService.models)
    // and the policy_version_hash used at callback time. Both are
    // needed for plan 11's effect binding to remain replayable.
    return `
      ALTER TABLE model_calls ADD COLUMN model_internal_id TEXT;
      ALTER TABLE model_calls ADD COLUMN policy_version_hash TEXT;
      CREATE INDEX IF NOT EXISTS idx_model_calls_provider_model
        ON model_calls(provider_id, model_internal_id);
    `;
  }

  private getV13Schema(): string {
    // Plan 02 §3.8.2 — egress_records table is required for the
    // Approve-then-Egress tier. Add columns rule_set_id, model_call_id
    // extension, and a redaction_records.rule_set_id column too.
    return `
      ALTER TABLE redaction_records ADD COLUMN rule_set_id TEXT;
      ALTER TABLE redaction_records ADD COLUMN approval_id TEXT;

      CREATE TABLE IF NOT EXISTS egress_records (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        model_call_id TEXT,
        route_decision_id TEXT,
        approval_id TEXT,
        egress_mode TEXT NOT NULL CHECK(egress_mode IN ('auto_redact', 'log_and_proceed', 'approve_then_egress')),
        payload_hash TEXT NOT NULL,
        payload_summary TEXT,
        redaction_rule_version TEXT,
        payload_classification TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_egress_records_run ON egress_records(run_id);
      CREATE INDEX IF NOT EXISTS idx_egress_records_model ON egress_records(model_call_id);
    `;
  }

  private getV12Schema(): string {
    // Sequence 0: Plan 03 §3.6 Approve-then-Egress requires a 5th
    // route value. SQLite CHECK constraints are immutable, so we
    // rebuild route_decisions with the new constraint. Run evidence
    // is preserved: the original table is renamed, copied into the
    // new schema, then dropped.
    return `
      CREATE TABLE route_decisions_new (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        route TEXT NOT NULL CHECK(route IN ('local', 'cloud', 'hybrid', 'redact_then_egress', 'blocked')),
        data_classification TEXT NOT NULL,
        high_water_sources_json TEXT,
        reason_json TEXT,
        local_steps_json TEXT,
        cloud_steps_json TEXT,
        requires_user_approval INTEGER,
        approval_id TEXT,
        policy_evaluation_id TEXT,
        provider_id TEXT,
        incident_ids_json TEXT,
        model_id TEXT,
        cloud_payload_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO route_decisions_new
        SELECT id, run_id, route, data_classification, high_water_sources_json,
               reason_json, local_steps_json, cloud_steps_json,
               requires_user_approval, approval_id, policy_evaluation_id,
               provider_id, incident_ids_json, model_id, cloud_payload_hash,
               created_at FROM route_decisions;
      DROP TABLE route_decisions;
      ALTER TABLE route_decisions_new RENAME TO route_decisions;
      CREATE INDEX IF NOT EXISTS idx_route_decisions_run ON route_decisions(run_id);
    `;
  }

  private getV10Schema(): string {
    // Sequence 0: ApprovalRequest scope binding + workspace ownership.
    // Adds columns needed by RunService.requestApproval / loadApproval.
    // The base migration (v1) did not include workspace_id, scope_hash,
    // policy_version_hash, payload_fingerprint, or revision. We use
    // idempotent SQL so re-running this migration on a partially
    // upgraded DB does not throw (SQLite forbids ALTER TABLE ADD
    // COLUMN when the column already exists).
    // Sequence 0 v10: original approval scope binding columns
    // for fresh databases only. Existing databases that already
    // applied v10 before revision was added here MUST upgrade via
    // v15 below. See plan 02 §3.4 approval row schema.
    return `
      ALTER TABLE approvals ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
      ALTER TABLE approvals ADD COLUMN scope_hash TEXT;
      ALTER TABLE approvals ADD COLUMN policy_version_hash TEXT;
      ALTER TABLE approvals ADD COLUMN payload_fingerprint TEXT;
      CREATE INDEX IF NOT EXISTS idx_approvals_workspace ON approvals(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_decision ON approvals(decision);
    `;
  }

  private getV11Schema(): string {
    // Sequence 0: agent_runs gains final_output_location (rename of
    // the existing column from v1 schema) — actually kept as a JSON
    // blob of the final answer + citations — plus error_message.
    return `
      -- error_message: short, sanitized error description written on failure.
      -- MUST NOT contain prompt content, raw adapter traces, or full payloads.
      ALTER TABLE agent_runs ADD COLUMN error_message TEXT;
    `;
  }

  private getInitialSchema(): string {
    return `
      -- Workspaces
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('personal', 'project', 'company')),
        default_data_classification TEXT NOT NULL DEFAULT 'Internal'
          CHECK(default_data_classification IN ('Public', 'Internal', 'Confidential', 'Restricted')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Knowledge Bases
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        classification TEXT NOT NULL DEFAULT 'Internal'
          CHECK(classification IN ('Public', 'Internal', 'Confidential', 'Restricted')),
        indexing_status TEXT NOT NULL DEFAULT 'queued'
          CHECK(indexing_status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        last_indexed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Documents
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        extension TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        classification TEXT NOT NULL DEFAULT 'Internal'
          CHECK(classification IN ('Public', 'Internal', 'Confidential', 'Restricted')),
        classification_source TEXT,
        source_trust_level TEXT DEFAULT 'user_imported',
        indexed_at TEXT
      );

      -- Document Chunks
      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_start_offset INTEGER NOT NULL,
        source_end_offset INTEGER NOT NULL,
        classification_snapshot TEXT NOT NULL,
        parser_version TEXT NOT NULL DEFAULT 'v1',
        chunker_version TEXT NOT NULL DEFAULT 'v1',
        allowed_for_context INTEGER NOT NULL DEFAULT 1
      );

      -- FTS5 on document_chunks content
      CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
        content,
        chunk_id UNINDEXED,
        workspace_id UNINDEXED
      );

      -- Agent Runs
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created'
          CHECK(status IN ('created', 'policy_precheck', 'retrieval', 'context_policy',
                           'route_decision', 'risk_classified', 'awaiting_approval',
                           'redaction_preview', 'model_invocation', 'completed',
                           'failed', 'cancelled', 'blocked')),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        final_output_location TEXT
      );

      -- Route Decisions
      CREATE TABLE IF NOT EXISTS route_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        route TEXT NOT NULL CHECK(route IN ('local', 'cloud', 'hybrid', 'redact_then_egress', 'blocked')),
        data_classification TEXT NOT NULL,
        high_water_sources_json TEXT,
        reason_json TEXT,
        local_steps_json TEXT,
        cloud_steps_json TEXT,
        requires_user_approval INTEGER NOT NULL DEFAULT 0,
        approval_id TEXT,
        policy_evaluation_id TEXT,
        provider_id TEXT,
        model_id TEXT,
        cloud_payload_summary TEXT,
        cloud_payload_hash TEXT,
        incident_ids_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Run Events (append-only with hash chain)
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        workspace_id TEXT,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_payload_json TEXT NOT NULL DEFAULT '{}',
        payload_hash TEXT,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE,
        policy_version_hash TEXT,
        redaction_rule_version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(run_id, sequence)
      );

      -- Policies
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        source TEXT,
        content_yaml TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Policy Evaluations
      CREATE TABLE IF NOT EXISTS policy_evaluations (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        policy_id TEXT,
        input_snapshot_json TEXT,
        result_json TEXT,
        matched_rules_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Approvals
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        approval_type TEXT NOT NULL,
        requested_scope_json TEXT,
        decision TEXT NOT NULL DEFAULT 'pending'
          CHECK(decision IN ('pending', 'approved', 'denied', 'expired')),
        decided_by TEXT,
        reason TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT
      );
      -- Model Providers
      CREATE TABLE IF NOT EXISTS model_providers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('ollama', 'openai_compatible')),
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        is_local INTEGER NOT NULL DEFAULT 1,
        data_retention_policy TEXT,
        training_opt_out INTEGER DEFAULT 0,
        region TEXT,
        zero_data_retention_supported INTEGER DEFAULT 0,
        supports_streaming INTEGER NOT NULL DEFAULT 1,
        supports_tool_calling INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      -- Models
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        display_name TEXT,
        modality TEXT NOT NULL DEFAULT 'text',
        local_only INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      -- Model Calls
      CREATE TABLE IF NOT EXISTS model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        adapter_kind TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        route_decision_id TEXT,
        approval_id TEXT,
        is_cloud INTEGER NOT NULL DEFAULT 0,
        prompt_hash TEXT,
        request_payload_hash TEXT,
        uploaded_payload_hash TEXT,
        http_body_hash TEXT,
        redaction_rule_version TEXT,
        response_hash TEXT,
        error_code TEXT,
        error_message TEXT,
        token_usage_json TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      -- Run Risk Summaries
      CREATE TABLE IF NOT EXISTS run_risk_summaries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'blocked')),
        risk_reasons_json TEXT,
        required_approvals_json TEXT,
        status TEXT NOT NULL DEFAULT 'assessed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Incidents
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        run_id TEXT,
        incident_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        summary TEXT NOT NULL,
        evidence_event_ids_json TEXT,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open', 'resolved', 'dismissed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );

      -- Memories (placeholder for Beta M3)
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('episodic', 'semantic', 'procedural')),
        content TEXT NOT NULL,
        source_run_id TEXT,
        source_event_ids_json TEXT,
        confidence REAL DEFAULT 1.0,
        user_confirmed INTEGER NOT NULL DEFAULT 0,
        scope TEXT DEFAULT 'workspace',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );

      -- Run Participants
      CREATE TABLE IF NOT EXISTS run_participants (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        role TEXT,
        audit_level INTEGER DEFAULT 1
      );

      -- Document Access Events
      CREATE TABLE IF NOT EXISTS document_access_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        chunk_id TEXT,
        access_type TEXT NOT NULL
          CHECK(access_type IN ('retrieved', 'selected_for_context', 'included_in_local_prompt',
                                'included_in_cloud_payload', 'redacted', 'blocked', 'excluded')),
        classification_snapshot TEXT,
        policy_evaluation_id TEXT,
        route_decision_id TEXT,
        model_call_id TEXT,
        payload_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Run Context Sources
      CREATE TABLE IF NOT EXISTS run_context_sources (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL
          CHECK(lifecycle_state IN ('retrieved', 'selected', 'local_context', 'redacted',
                                    'cloud_context', 'blocked', 'excluded')),
        retrieval_method TEXT,
        score REAL,
        source_start_offset INTEGER,
        source_end_offset INTEGER,
        source_line_start INTEGER,
        source_line_end INTEGER,
        classification_snapshot TEXT,
        cloud_payload_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Tool Calls
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        agent_id TEXT,
        tool_name TEXT NOT NULL,
        requested_scope_json TEXT,
        decision TEXT NOT NULL
          CHECK(decision IN ('allowed', 'denied', 'blocked')),
        policy_evaluation_id TEXT,
        approval_id TEXT,
        input_hash TEXT,
        output_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Redaction Records
      CREATE TABLE IF NOT EXISTS redaction_records (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        model_call_id TEXT,
        rule_version TEXT NOT NULL,
        before_hash TEXT NOT NULL,
        after_hash TEXT NOT NULL,
        summary TEXT,
        residual_risk TEXT,
        user_confirmed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Policy Scopes
      CREATE TABLE IF NOT EXISTS policy_scopes (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
        workspace_id TEXT,
        knowledge_base_id TEXT,
        classification TEXT,
        provider_id TEXT,
        model_id TEXT,
        agent_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      -- Classification Model Allowlists
      CREATE TABLE IF NOT EXISTS classification_model_allowlists (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        classification TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        allowed INTEGER NOT NULL DEFAULT 1
      );

      -- Agent Permissions
      CREATE TABLE IF NOT EXISTS agent_permissions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        permission_kind TEXT NOT NULL,
        scope_json TEXT,
        allowed INTEGER NOT NULL DEFAULT 0
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_workspace ON document_chunks(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_routes_run ON route_decisions(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_model_calls_run ON model_calls(run_id);
      CREATE INDEX IF NOT EXISTS idx_incidents_workspace ON incidents(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_access_events_run ON document_access_events(run_id);
      CREATE INDEX IF NOT EXISTS idx_context_sources_run ON run_context_sources(run_id);
    `;
  }

  private getM3Schema(): string {
    return `
      -- M3 Episodic Memories
      CREATE TABLE IF NOT EXISTS episodic_memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_summary TEXT NOT NULL,
        occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
        participating_agent_ids_json TEXT,
        source_run_id TEXT,
        source_file_ids_json TEXT,
        source_route_decision_id TEXT,
        source_event_ids_json TEXT,
        confidence REAL NOT NULL DEFAULT 0.8,
        scope TEXT DEFAULT 'workspace',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );

      -- M3 Semantic Memories
      CREATE TABLE IF NOT EXISTS semantic_memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        relation TEXT NOT NULL,
        object TEXT NOT NULL,
        source_run_id TEXT,
        source_file_ids_json TEXT,
        source_route_decision_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        user_confirmed INTEGER NOT NULL DEFAULT 0,
        scope TEXT DEFAULT 'workspace',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );

      -- M3 Procedural Memories
      CREATE TABLE IF NOT EXISTS procedural_memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        recommended_agent_group_id TEXT,
        toolchain_json TEXT,
        route_policy_id TEXT,
        failure_notes TEXT,
        source_run_id TEXT,
        user_confirmed INTEGER NOT NULL DEFAULT 0,
        scope TEXT DEFAULT 'workspace',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );

      -- Memory Access Events
      CREATE TABLE IF NOT EXISTS memory_access_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        memory_id TEXT NOT NULL,
        memory_type TEXT NOT NULL CHECK(memory_type IN ('episodic', 'semantic', 'procedural')),
        access_type TEXT NOT NULL CHECK(access_type IN ('read', 'proposed_write', 'confirmed_write', 'edited', 'deleted', 'denied')),
        policy_evaluation_id TEXT,
        route_decision_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Agent Groups
      CREATE TABLE IF NOT EXISTS agent_groups (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('pipeline', 'parallel', 'debate')),
        description TEXT,
        default_policy_id TEXT,
        max_rounds INTEGER DEFAULT 10,
        max_tokens INTEGER DEFAULT 32000,
        max_duration_ms INTEGER DEFAULT 300000,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Agent Group Members
      CREATE TABLE IF NOT EXISTS agent_group_members (
        id TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT,
        step_order INTEGER,
        permissions_snapshot_json TEXT
      );

      -- Agent Group Runs
      CREATE TABLE IF NOT EXISTS agent_group_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_group_id TEXT,
        mode TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        high_water_classification TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      -- Run Steps
      CREATE TABLE IF NOT EXISTS run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        agent_group_run_id TEXT,
        step_index INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        input_hash TEXT,
        output_hash TEXT,
        route_decision_id TEXT,
        policy_evaluation_id TEXT,
        model_call_id TEXT,
        started_at TEXT,
        completed_at TEXT
      );

      -- Messages
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        step_id TEXT,
        sender_agent_id TEXT,
        role TEXT NOT NULL,
        content_hash TEXT,
        content_summary TEXT,
        classification_snapshot TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Artifacts
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT,
        step_id TEXT,
        artifact_type TEXT NOT NULL,
        storage_ref TEXT,
        content_hash TEXT,
        classification TEXT,
        source_event_ids_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Recipes
      CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        required_capabilities_json TEXT,
        agent_group_template_json TEXT,
        policy_requirements_json TEXT,
        source TEXT DEFAULT 'local',
        trusted INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Workflow Saves
      CREATE TABLE IF NOT EXISTS workflow_saves (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_run_id TEXT,
        recipe_id TEXT,
        agent_group_id TEXT,
        saved_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Self-Build Recommendations
      CREATE TABLE IF NOT EXISTS self_build_recommendations (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        workspace_id TEXT NOT NULL,
        missing_capability TEXT NOT NULL,
        candidate_recipe_ids_json TEXT,
        candidate_agent_ids_json TEXT,
        rationale TEXT,
        decision TEXT DEFAULT 'pending' CHECK(decision IN ('pending', 'accepted', 'rejected')),
        decided_at TEXT
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_episodic_memories_ws ON episodic_memories(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_semantic_memories_ws ON semantic_memories(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_procedural_memories_ws ON procedural_memories(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_agent_groups_ws ON agent_groups(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_group_runs_ws ON agent_group_runs(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_run_steps_group ON run_steps(agent_group_run_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_ws ON artifacts(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_recipes_ws ON recipes(workspace_id);
    `;
  }

  private getV3Schema(): string {
    return `
      -- Agents (referenced by agent_group_members, run_participants)
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        manifest_json TEXT,
        capability_matrix_json TEXT,
        audit_level INTEGER DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Secrets Metadata (value stored in encrypted file via SecretBroker)
      CREATE TABLE IF NOT EXISTS secrets_metadata (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        masked_value TEXT NOT NULL,
        secret_store_ref TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      );

      -- Add audit_event_id to route_decisions for audit trail
      ALTER TABLE route_decisions ADD COLUMN audit_event_id TEXT;

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_secrets_provider ON secrets_metadata(provider_id);
    `;
  }

  private getV4Schema(): string {
    return `
      -- Add line number metadata and injection flag to document_chunks
      ALTER TABLE document_chunks ADD COLUMN source_line_start INTEGER;
      ALTER TABLE document_chunks ADD COLUMN source_line_end INTEGER;
      ALTER TABLE document_chunks ADD COLUMN instructional_content_detected INTEGER NOT NULL DEFAULT 0;

      -- Indexes for the new columns
      CREATE INDEX IF NOT EXISTS idx_chunks_line_start ON document_chunks(source_line_start);
    `;
  }

  private getV5Schema(): string {
    return `-- FK constraints deferred: existing tests create events without parent records.
-- Application-layer FK enforcement is handled in database-service.ts.`;
  }

  private getV6Schema(): string {
    return `
      -- Remove the legacy memories table (replaced by episodic_memories,
      -- semantic_memories, procedural_memories in migration v2)
      DROP TABLE IF EXISTS memories;
    `;
  }

  private getV7Schema(): string {
    return `
      -- FTS5 virtual tables for memory search
      CREATE VIRTUAL TABLE IF NOT EXISTS episodic_memories_fts USING fts5(
        event_summary,
        memory_id UNINDEXED,
        workspace_id UNINDEXED
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memories_fts USING fts5(
        subject, relation, object,
        memory_id UNINDEXED,
        workspace_id UNINDEXED
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS procedural_memories_fts USING fts5(
        task_type, failure_notes,
        memory_id UNINDEXED,
        workspace_id UNINDEXED
      );
    `;
  }

  private getV8Schema(): string {
    return `
      -- Indexes for content_hash lookups (dedup, verification)
      CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
      CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON document_chunks(content_hash);
    `;
  }

  private getV9Schema(): string {
    return `
      -- Add FK constraints for agent_runs references
      -- route_decisions.run_id -> agent_runs.id
      -- model_calls.run_id -> agent_runs.id
      -- run_events.run_id -> agent_runs.id
      -- These are soft-FK via index + application-layer checks.
      -- True SQLite FK constraints require parent records to exist first,
      -- which is enforced by the application layer in database-service.ts.
      CREATE INDEX IF NOT EXISTS idx_route_decisions_run_id ON route_decisions(run_id);
      CREATE INDEX IF NOT EXISTS idx_model_calls_run_id ON model_calls(run_id);
      CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);
    `;
  }
}

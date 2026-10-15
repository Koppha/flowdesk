import { query } from "../../lib/db.js";

// BRS (Business Requirement Specification): a collaborative document-drafting
// + approval workflow. Kept as its own schema rather than folded into
// custom_request_types/request_type_fields — a BRS section is a materially
// different concept from a form field (it's owned by a phase and a
// department, carries an SLA, and holds rich-text content, not a typed
// scalar), and every other request type sharing those tables would otherwise
// need to grow BRS-shaped branches. The one deliberate seam back into the
// existing engine is Approval Routing — see brs.service.ts and the
// BRS_APPROVAL custom_request_types row seeded in bootstrap/system.ts.
export async function ensureBrsSchema() {
  // Backs human-readable reference numbers (BRS-<year>-<seq>) — a sequence
  // rather than a COUNT(*)-based scheme so concurrent Intake submissions
  // can never collide on the same number.
  await query(`CREATE SEQUENCE IF NOT EXISTS brs_reference_seq`);

  // ── Definition tables (admin-configurable templates) ──────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS brs_types (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      name          text        NOT NULL,
      code          text        NOT NULL,
      description   text,
      icon          text,
      color         text,
      status        text        NOT NULL DEFAULT 'DRAFT',
      is_active     boolean     NOT NULL DEFAULT true,
      created_by_id uuid        REFERENCES users(id),
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT brs_types_code_uq UNIQUE (code)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS brs_type_sections (
      id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      brs_type_id        uuid        NOT NULL REFERENCES brs_types(id) ON DELETE CASCADE,
      section_key        text        NOT NULL,
      title              text        NOT NULL,
      description        text,
      owner_phase        text        NOT NULL DEFAULT 'DRAFT',
      default_department text,
      is_required        boolean     NOT NULL DEFAULT true,
      sla_hours          integer,
      sort_order         integer     NOT NULL DEFAULT 0,
      is_active          boolean     NOT NULL DEFAULT true,
      created_at         timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_type_sections_type ON brs_type_sections(brs_type_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS brs_type_permissions (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      brs_type_id      uuid        NOT NULL REFERENCES brs_types(id) ON DELETE CASCADE,
      permission_type  text        NOT NULL DEFAULT 'ALL',
      department       text,
      user_id          uuid        REFERENCES users(id) ON DELETE CASCADE,
      employment_type  text,
      can_submit       boolean     NOT NULL DEFAULT true,
      can_design       boolean     NOT NULL DEFAULT false,
      created_by_id    uuid        REFERENCES users(id),
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_type_perms_type ON brs_type_permissions(brs_type_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_type_perms_user ON brs_type_permissions(user_id)`);

  // ── Instance tables (the actual documents people create) ──────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS brs_documents (
      id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      brs_type_id                 uuid        NOT NULL REFERENCES brs_types(id),
      title                       text        NOT NULL,
      reference_no                text        UNIQUE,
      requester_id                uuid        NOT NULL REFERENCES users(id),
      phase                       text        NOT NULL DEFAULT 'INTAKE',
      intake_data                 jsonb       NOT NULL DEFAULT '{}',
      current_version_id          uuid,
      brs_approval_submission_id  uuid        REFERENCES custom_request_submissions(id),
      return_comment              text,
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_documents_requester ON brs_documents(requester_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_documents_phase ON brs_documents(phase)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_documents_type ON brs_documents(brs_type_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS brs_document_sections (
      id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id     uuid        NOT NULL REFERENCES brs_documents(id) ON DELETE CASCADE,
      type_section_id uuid        REFERENCES brs_type_sections(id),
      section_key     text        NOT NULL,
      title           text        NOT NULL,
      description     text,
      owner_phase     text        NOT NULL,
      is_required     boolean     NOT NULL DEFAULT true,
      sla_hours       integer,
      sort_order      integer     NOT NULL DEFAULT 0,
      content_html    text,
      status          text        NOT NULL DEFAULT 'PENDING',
      due_at          timestamptz,
      submitted_by_id uuid        REFERENCES users(id),
      submitted_at    timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_doc_sections_document ON brs_document_sections(document_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS brs_document_section_assignees (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      section_id       uuid        NOT NULL REFERENCES brs_document_sections(id) ON DELETE CASCADE,
      user_id          uuid        REFERENCES users(id),
      section_ref_id   uuid        REFERENCES sections(id),
      confirmed        boolean     NOT NULL DEFAULT false,
      confirmed_at     timestamptz,
      confirmed_by_id  uuid        REFERENCES users(id),
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_section_assignees_section ON brs_document_section_assignees(section_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_section_assignees_user ON brs_document_section_assignees(user_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS brs_document_versions (
      id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id     uuid        NOT NULL REFERENCES brs_documents(id) ON DELETE CASCADE,
      version_number  integer     NOT NULL,
      snapshot        jsonb       NOT NULL,
      baselined_by_id uuid        REFERENCES users(id),
      baselined_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT brs_doc_versions_uq UNIQUE (document_id, version_number)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_doc_versions_document ON brs_document_versions(document_id)`);

  // People: the owner has the same full rights as the creator (requester_id);
  // co-writers can edit content (sections and Intake) but not drive the
  // workflow. amending_from_version marks an approved BRS reopened for
  // amendment - re-approval baselines the next version.
  await query(`ALTER TABLE brs_documents ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id)`);
  await query(`ALTER TABLE brs_documents ADD COLUMN IF NOT EXISTS amending_from_version integer`);
  await query(`
    CREATE TABLE IF NOT EXISTS brs_document_collaborators (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id   uuid        NOT NULL REFERENCES brs_documents(id) ON DELETE CASCADE,
      user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role          text        NOT NULL DEFAULT 'CO_WRITER',
      added_by_id   uuid        REFERENCES users(id) ON DELETE SET NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT brs_doc_collaborators_uq UNIQUE (document_id, user_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_doc_collaborators_user ON brs_document_collaborators(user_id)`);
  // Groups as well as people, for both section assignees and co-writers:
  // a Department (sections row), a Section (teams row) or a whole Division
  // (users.department name). Anyone currently in the group qualifies.
  await query(`ALTER TABLE brs_document_collaborators ALTER COLUMN user_id DROP NOT NULL`);
  await query(`ALTER TABLE brs_document_collaborators ADD COLUMN IF NOT EXISTS section_ref_id uuid REFERENCES sections(id) ON DELETE CASCADE`);
  await query(`ALTER TABLE brs_document_collaborators ADD COLUMN IF NOT EXISTS team_ref_id uuid REFERENCES teams(id) ON DELETE CASCADE`);
  await query(`ALTER TABLE brs_document_collaborators ADD COLUMN IF NOT EXISTS division_name text`);
  await query(`ALTER TABLE brs_document_section_assignees ADD COLUMN IF NOT EXISTS team_ref_id uuid REFERENCES teams(id) ON DELETE CASCADE`);
  await query(`ALTER TABLE brs_document_section_assignees ADD COLUMN IF NOT EXISTS division_name text`);
  // What each co-writer may do, granted by the creator/owner:
  // EDIT, INVITE, WORKFLOW (send on, route, reopen), DISTRIBUTE, AMEND.
  // Empty = view only.
  await query(`ALTER TABLE brs_document_collaborators ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL DEFAULT ARRAY['EDIT']::text[]`);
  // Who invited a section collaborator - they (and the creator/owner) can cancel it.
  await query(`ALTER TABLE brs_document_section_assignees ADD COLUMN IF NOT EXISTS added_by_id uuid REFERENCES users(id) ON DELETE SET NULL`);

  // Audit trail: every saved version of a section / the Intake, and every
  // workflow event, with who did it and in what capacity on this document.
  await query(`
    CREATE TABLE IF NOT EXISTS brs_document_revisions (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id   uuid        NOT NULL REFERENCES brs_documents(id) ON DELETE CASCADE,
      kind          text        NOT NULL,
      section_id    uuid        REFERENCES brs_document_sections(id) ON DELETE SET NULL,
      section_title text,
      content_html  text,
      intake_data   jsonb,
      summary       text,
      phase         text,
      actor_id      uuid        REFERENCES users(id) ON DELETE SET NULL,
      actor_role    text,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_brs_doc_revisions_document ON brs_document_revisions(document_id, created_at)`);

  // Added after brs_document_versions exists so the FK can be declared.
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'brs_documents_current_version_fk'
      ) THEN
        ALTER TABLE brs_documents
          ADD CONSTRAINT brs_documents_current_version_fk
          FOREIGN KEY (current_version_id) REFERENCES brs_document_versions(id);
      END IF;
    END $$;
  `);
}

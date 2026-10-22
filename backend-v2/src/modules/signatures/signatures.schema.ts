import { query } from "../../lib/db.js";

// document_signatures is deliberately standalone - not a foreign key onto
// any specific request type. A signature can be attached to any existing
// FlowDesk record (source_type/source_id, both optional) or to nothing at
// all (a document someone just uploaded to be signed). This is what makes
// the same capability reusable for approval steps later without a schema
// change - a new source_type is just a new string, not a new table.
export async function ensureSignaturesSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS document_signatures (
      id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      verification_code     text        NOT NULL,
      title                 text        NOT NULL,
      source_type           text,
      source_id             uuid,
      signer_id             uuid        NOT NULL REFERENCES users(id),
      authority_user_id     uuid        REFERENCES users(id),
      delegation_notation   text,
      signature_typed_name  text,
      signature_image       text,
      consent_statement     text        NOT NULL,
      original_file_path    text        NOT NULL,
      original_file_name    text        NOT NULL,
      signed_file_path      text        NOT NULL,
      content_hash          text        NOT NULL,
      signer_ip             text,
      status                text        NOT NULL DEFAULT 'VALID',
      signed_at             timestamptz NOT NULL DEFAULT now(),
      created_at            timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_document_signatures_code ON document_signatures(verification_code)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_document_signatures_signer ON document_signatures(signer_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_document_signatures_source ON document_signatures(source_type, source_id)`);

  // One saved signature per user, reused to prefill the signing form instead
  // of drawing/typing it fresh every time - purely a convenience cache, not
  // itself evidence of anything (the consent + hash on each individual
  // document_signatures row is what makes that signature legally meaningful).
  await query(`
    CREATE TABLE IF NOT EXISTS user_saved_signatures (
      user_id       uuid PRIMARY KEY REFERENCES users(id),
      signature_type text NOT NULL,
      typed_name    text,
      image_data_url text,
      updated_at    timestamptz NOT NULL DEFAULT now()
    )
  `);

  // A "routing document" carries multiple signers over time (the paper
  // multi-GM sign-off sheet this was built for) - one shared verification
  // code for the whole document, current_file_path/current_content_hash
  // advancing with each added signature rather than the single-shot,
  // sign-once-and-done model document_signatures above covers.
  await query(`
    CREATE TABLE IF NOT EXISTS signable_documents (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      verification_code   text NOT NULL,
      title               text NOT NULL,
      original_file_path  text NOT NULL,
      original_file_name  text NOT NULL,
      current_file_path   text NOT NULL,
      current_content_hash text NOT NULL,
      created_by_id       uuid NOT NULL REFERENCES users(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_signable_documents_code ON signable_documents(verification_code)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_signable_documents_creator ON signable_documents(created_by_id)`);

  // Optional approval route: an ordered list of {approver_id, approver_name,
  // status, comment, acted_at} the creator can define at creation. Empty
  // array (the default) keeps the original free-for-all behavior - anyone
  // with the link can sign, in any order. A non-empty chain restricts
  // signing to whoever is at current_step_order, advances automatically on
  // each signature, and lets that step reject instead (status flips
  // straight to REJECTED, a terminal state - see signatures.service.ts).
  // Added via ALTER, not inline in the CREATE TABLE above, since this table
  // already existed in earlier deployments.
  await query(`ALTER TABLE signable_documents ADD COLUMN IF NOT EXISTS approval_chain jsonb NOT NULL DEFAULT '[]'`);
  await query(`ALTER TABLE signable_documents ADD COLUMN IF NOT EXISTS current_step_order int NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE signable_documents ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'OPEN'`);
  // A document with no route stays open until its creator finishes it
  // (Finish signing) - then it's COMPLETED and nobody can sign it again.
  await query(`ALTER TABLE signable_documents ADD COLUMN IF NOT EXISTS closed_at timestamptz`);
  await query(`ALTER TABLE signable_documents ADD COLUMN IF NOT EXISTS closed_by_id uuid REFERENCES users(id) ON DELETE SET NULL`);

  await query(`
    CREATE TABLE IF NOT EXISTS document_signature_placements (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id          uuid NOT NULL REFERENCES signable_documents(id),
      signer_id            uuid NOT NULL REFERENCES users(id),
      authority_user_id    uuid REFERENCES users(id),
      delegation_notation  text,
      signature_typed_name text,
      signature_image      text,
      consent_statement    text NOT NULL,
      page_number          int  NOT NULL,
      x_pct                double precision NOT NULL,
      y_pct                double precision NOT NULL,
      mark_width_pct       double precision NOT NULL,
      signer_ip            text,
      signed_at            timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_doc_sig_placements_document ON document_signature_placements(document_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_doc_sig_placements_signer ON document_signature_placements(signer_id)`);
}

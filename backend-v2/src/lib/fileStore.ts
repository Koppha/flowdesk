import fs from "fs";
import path from "path";
import multer from "multer";
import { query } from "./db.js";
import { logger, serializeError } from "./logger.js";

// Uploaded and generated files (receipts, payback proofs, attachments,
// signed PDFs...) live on each server's disk, which is not shared between
// PROD1 and PROD2 and used to sit inside each release folder - so a file
// could be missing on the other server, and old releases took their files
// with them when deleted (13 receipts/proofs lost by Oct 2026).
//
// Every file is therefore also kept in the shared database, keyed by its
// path from "uploads/" on. Reading a file restores it from the database when
// this server doesn't have it.

const MAX_DB_BYTES = 50 * 1024 * 1024; // larger files (e.g. app builds) stay disk-only

export async function ensureFileStoreSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS stored_files (
      key        text PRIMARY KEY,
      bytes      bytea NOT NULL,
      size       integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
}

// "uploads/signatures/x.pdf", whatever folder the path was written under
// (relative, or absolute inside an old release).
export function storeKey(filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  const i = p.lastIndexOf("/uploads/");
  if (i >= 0) return p.slice(i + 1);
  if (p.startsWith("uploads/")) return p;
  return `uploads/${path.basename(p)}`;
}

export async function persistFile(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_DB_BYTES) return;
    await query(
      `INSERT INTO stored_files (key, bytes, size) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET bytes = EXCLUDED.bytes, size = EXCLUDED.size`,
      [storeKey(filePath), fs.readFileSync(filePath), stat.size]
    );
  } catch (err) {
    logger.warn("file_store_persist_failed", { path: filePath, error: serializeError(err) });
  }
}

// The path to read from: as stored if it's on this disk, else this
// release's uploads folder - restored from the database if needed.
// Returns null when the file exists nowhere.
export async function ensureLocalFile(filePath: string | null | undefined): Promise<string | null> {
  if (!filePath) return null;
  if (fs.existsSync(filePath)) return filePath;
  const key = storeKey(filePath);
  const local = path.join(process.cwd(), key);
  if (fs.existsSync(local)) return local;
  const row = (await query<{ bytes: Buffer }>(`SELECT bytes FROM stored_files WHERE key = $1`, [key]))[0];
  if (!row) return null;
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, row.bytes);
  return local;
}

export async function readStoredFile(filePath: string): Promise<Buffer> {
  const p = await ensureLocalFile(filePath);
  if (!p) throw Object.assign(new Error("File not found"), { status: 404 });
  return fs.readFileSync(p);
}

// Write a generated file and keep it in the database too.
export async function writeStoredFile(filePath: string, data: Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
  await persistFile(filePath);
}

// multer disk storage that also saves each upload to the database before
// the route handler runs.
export function persistentDiskStorage(opts: multer.DiskStorageOptions): multer.StorageEngine {
  const inner = multer.diskStorage(opts) as any;
  return {
    _handleFile(req: any, file: any, cb: any) {
      inner._handleFile(req, file, (err: any, info: any) => {
        if (err || !info?.path) return cb(err, info);
        persistFile(info.path).then(() => cb(null, info), () => cb(null, info));
      });
    },
    _removeFile(req: any, file: any, cb: any) {
      inner._removeFile(req, file, cb);
    }
  } as multer.StorageEngine;
}

// At startup: copy every file this server already has into the database
// (existing rows are left alone), so nothing older is missing elsewhere.
export async function backfillUploadsToStore(root = path.join(process.cwd(), "uploads")) {
  if (!fs.existsSync(root)) return;
  const known = new Set((await query<{ key: string }>(`SELECT key FROM stored_files`)).map((r) => r.key));
  let added = 0;
  const walk = async (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || known.has(storeKey(full))) continue;
      await persistFile(full);
      added++;
    }
  };
  try {
    await walk(root);
    if (added) logger.info("file_store_backfilled", { added });
  } catch (err) {
    logger.warn("file_store_backfill_failed", { error: serializeError(err) });
  }
}

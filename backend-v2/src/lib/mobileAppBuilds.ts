import { query } from "./db.js";

// Uploaded FlowDesk Mobile APKs - "Inside FlowDesk: Get the App" serves the
// most recent row's file straight from here (see mobile-app.routes.ts).
// Being logged into FlowDesk at all is the only access control, by design -
// there's no public store listing, so an authenticated session is the
// allow-list.
export async function ensureMobileAppBuildsSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS mobile_app_builds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      platform text NOT NULL DEFAULT 'ANDROID',
      version text NOT NULL,
      original_filename text NOT NULL,
      file_path text NOT NULL,
      size_bytes bigint NOT NULL,
      uploaded_by_id uuid REFERENCES users(id),
      uploaded_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export type MobileAppBuild = {
  id: string;
  platform: string;
  version: string;
  original_filename: string;
  file_path: string;
  size_bytes: number;
  uploaded_by_id: string | null;
  uploaded_at: string;
};

export async function saveMobileAppBuild(args: {
  platform: string;
  version: string;
  originalFilename: string;
  filePath: string;
  sizeBytes: number;
  uploadedById: string;
}) {
  const [row] = await query<MobileAppBuild>(
    `INSERT INTO mobile_app_builds (platform, version, original_filename, file_path, size_bytes, uploaded_by_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [args.platform, args.version, args.originalFilename, args.filePath, args.sizeBytes, args.uploadedById]
  );
  return row;
}

export async function getLatestMobileAppBuild(platform = "ANDROID") {
  const [row] = await query<MobileAppBuild>(
    `SELECT * FROM mobile_app_builds WHERE platform = $1 ORDER BY uploaded_at DESC LIMIT 1`,
    [platform]
  );
  return row || null;
}

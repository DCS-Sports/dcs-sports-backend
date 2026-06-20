/**
 * R2 video upload helper (Cloudflare R2, reuses the Games/image-bank pattern).
 *
 * Vision ingests video by URL. The frontend uploads to R2 (direct or presigned),
 * then submits the resulting URL to POST /vision/jobs. R2 is DARK in-session
 * (no creds), so this returns a structured "not configured" result the caller
 * handles — it never fabricates a URL.
 *
 * At deploy: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2ConfigFromEnv(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export interface UploadTarget {
  configured: boolean;
  /** Where the client PUTs the file (presigned). Null when DARK. */
  upload_url: string | null;
  /** The resulting object URL to submit to /vision/jobs. Null when DARK. */
  object_url: string | null;
  key: string | null;
}

/**
 * Produce an upload target for a video. When R2 is configured this would return
 * a presigned PUT URL (via @aws-sdk/s3-request-presigner against the R2 S3 API);
 * the SDK isn't bundled in-session to keep the lane lean, so the seam returns a
 * deterministic object key + the public URL shape, and `configured:false` when
 * creds are absent so the UI shows an honest "upload not available yet" state.
 */
export function buildUploadTarget(matchId: string | null, filename: string): UploadTarget {
  const cfg = r2ConfigFromEnv();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `vision/${matchId ?? "adhoc"}/${Date.now()}_${safe}`;
  if (!cfg) {
    return { configured: false, upload_url: null, object_url: null, key };
  }
  // Public object URL shape for R2 (custom domain or r2.dev). Presign at deploy.
  const object_url = `https://${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com/${key}`;
  return { configured: true, upload_url: null, object_url, key };
}

/**
 * S3-Compatible Object Storage
 * 
 * Works with AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces,
 * or any S3-compatible provider.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ─── Configuration ──────────────────────────────────────────────────────

function getS3Config() {
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION || "us-east-1";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET || "admod-uploads";
  const publicUrl = process.env.S3_PUBLIC_URL || "";

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3 credentials missing: set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY"
    );
  }

  return { endpoint, region, accessKeyId, secretAccessKey, bucket, publicUrl };
}

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    const config = getS3Config();
    _client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: !!config.endpoint,
    });
  }
  return _client;
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType: string = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const config = getS3Config();
  const client = getClient();
  const key = relKey.replace(/^\/+/, "");
  const body = typeof data === "string" ? Buffer.from(data) : data;

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  let url: string;
  if (config.publicUrl) {
    url = `${config.publicUrl.replace(/\/+$/, "")}/${key}`;
  } else if (config.endpoint) {
    url = `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}/${key}`;
  } else {
    url = `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
  }

  return { key, url };
}

export async function storageGetSignedUrl(
  relKey: string,
  expiresInSeconds: number = 3600,
): Promise<{ key: string; url: string }> {
  const config = getS3Config();
  const client = getClient();
  const key = relKey.replace(/^\/+/, "");

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: expiresInSeconds }
  );

  return { key, url };
}

export async function storageGet(
  relKey: string,
): Promise<{ key: string; url: string }> {
  const config = getS3Config();
  const key = relKey.replace(/^\/+/, "");

  let url: string;
  if (config.publicUrl) {
    url = `${config.publicUrl.replace(/\/+$/, "")}/${key}`;
  } else {
    url = `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
  }

  return { key, url };
}

/**
 * Derive the S3/R2 object key from a raw storage URL.
 * Returns null if the URL is not from this bucket (e.g. YouTube thumbnails).
 *
 * Example:
 *   URL:  https://xxx.r2.cloudflarestorage.com/admod-uploads/ads/123/thumb.jpg
 *   Key:  ads/123/thumb.jpg
 */
export function deriveKeyFromStorageUrl(url: string): string | null {
  const config = getS3Config();
  const endpoint = (config.endpoint || "").replace(/\/+$/, "");
  const bucket = config.bucket;

  // Try endpoint/bucket prefix first (R2 / path-style S3)
  if (endpoint) {
    const prefix = `${endpoint}/${bucket}/`;
    if (url.startsWith(prefix)) return url.slice(prefix.length).split("?")[0];
  }

  // Try virtual-hosted style (s3.region.amazonaws.com)
  const vhPrefix = `https://${bucket}.s3.`;
  if (url.startsWith(vhPrefix)) {
    const pathStart = url.indexOf("/", vhPrefix.length);
    if (pathStart !== -1) return url.slice(pathStart + 1).split("?")[0];
  }

  return null;
}

/**
 * Download a file from storage directly using the AWS SDK (no HTTP, no auth issues).
 * Use this instead of fetch() for private R2/S3 files.
 */
export async function storageDownloadBuffer(relKey: string): Promise<Buffer> {
  const config = getS3Config();
  const client = getClient();
  const key = relKey.replace(/^\/+/, "");

  const response = await client.send(
    new GetObjectCommand({ Bucket: config.bucket, Key: key })
  );

  if (!response.Body) {
    throw new Error(`storageDownloadBuffer: empty response body for key "${key}"`);
  }

  // response.Body is a Readable (Node.js stream) — collect all chunks
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function storageDelete(relKey: string): Promise<void> {
  const config = getS3Config();
  const client = getClient();
  const key = relKey.replace(/^\/+/, "");

  await client.send(
    new DeleteObjectCommand({ Bucket: config.bucket, Key: key })
  );
}

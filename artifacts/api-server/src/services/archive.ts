import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { gzipSync } from "node:zlib";
import { pool } from "../tracking/store.ts";
let client: S3Client | undefined;
export async function archiveReceipts() {
  const bucket = process.env.ARCHIVE_BUCKET;
  if (!bucket) return;
  client ??= new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            ...(process.env.AWS_SESSION_TOKEN
              ? { sessionToken: process.env.AWS_SESSION_TOKEN }
              : {}),
          },
        }
      : {}),
    ...(process.env.ARCHIVE_ENDPOINT
      ? { endpoint: process.env.ARCHIVE_ENDPOINT }
      : {}),
    forcePathStyle: process.env.ARCHIVE_PATH_STYLE === "true",
  });
  const rows = (
    await pool.query(
      "SELECT signature,payload,received_at FROM cw_receipts WHERE archived=false AND received_at<now()-interval '1 day' ORDER BY received_at LIMIT 100",
    )
  ).rows;
  for (const row of rows) {
    const day = new Date(row.received_at).toISOString().slice(0, 10);
    const key = `crypsor/receipts/${day}/${encodeURIComponent(row.signature)}.json.gz`;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: gzipSync(JSON.stringify(row.payload)),
        ContentType: "application/json",
        ContentEncoding: "gzip",
      }),
    );
    await pool.query(
      "UPDATE cw_receipts SET archived=true WHERE signature=$1",
      [row.signature],
    );
  }
}

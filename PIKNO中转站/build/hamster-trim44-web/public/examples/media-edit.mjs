// Node.js 22+: PIKNO_API_KEY=... node media-edit.mjs reference.png
// Paid edit: run only when you intend to generate one image. Never auto-retries.
// 原文件以 direct-v1 multipart 发送；不带报价头的兼容调用，运行前核对已发布价格和参数。
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const files = process.argv.slice(2),
  base = "https://www.piknoai.com";
if (!process.env.PIKNO_API_KEY || files.length !== 1) {
  throw new Error("Set PIKNO_API_KEY and pass one PNG/JPEG/WebP file");
}
const type = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}[extname(files[0]).toLowerCase()];
if (!type) throw new Error("Unsupported image extension");
let bytes;
try {
  bytes = await readFile(files[0]);
} catch {
  throw new Error("Cannot read the reference image");
}
if (bytes.length < 12 || bytes.length > 30 << 20) {
  throw new Error("Reference image must contain 12 bytes to 30 MiB");
}
const form = new FormData();
for (const [field, value] of Object.entries({
  model: process.env.PIKNO_IMAGE_MODEL || "pikno-image-flare",
  prompt: process.env.PIKNO_PROMPT || "将参考图中的主色调整为蓝色，保留主体形状和构图。",
  n: "1",
  size: process.env.PIKNO_IMAGE_SIZE || "1024x1024",
  quality: process.env.PIKNO_IMAGE_QUALITY || "high",
  output_format: "png",
})) {
  form.append(field, value);
}
form.append("image", new Blob([bytes], { type }), `reference.${type.split("/")[1]}`);
let response;
try {
  response = await fetch(`${base}/v1/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PIKNO_API_KEY}`,
      "X-Pikno-Media-Transport": "direct-v1",
    },
    body: form,
    signal: AbortSignal.timeout(600000),
  });
} catch {
  throw new Error(
    "Submission response unconfirmed; check original task and billing records before any explicit retry",
  );
}
let result;
try {
  result = await response.json();
} catch {
  throw new Error(
    "Submission result unconfirmed; check original task and billing records before any explicit retry",
  );
}
if (!response.ok) {
  throw new Error(
    `HTTP ${response.status}; check original task and billing records before any explicit retry`,
  );
}
// Consume/save result.data in your own application. Never log credentials, media URLs or image bodies.
// oxlint-disable-next-line no-console -- This CLI prints fixed whitelist metadata only, never result contents.
console.log(
  JSON.stringify({
    response_received: true,
    images_received: Array.isArray(result?.data) ? result.data.length : 0,
    task_reference_received: typeof result?.id === "string",
  }),
);

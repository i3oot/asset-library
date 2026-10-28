import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";
import { signRenderRequest } from "../../../renderer/request-auth.mjs";

sharp.cache(false);
sharp.concurrency(2);

export async function generateThumbnail(input: Uint8Array): Promise<{ bytes: Buffer; thumbhash: string }> {
  const image = sharp(input, { limitInputPixels: 64 * 1024 * 1024, failOn: "error", sequentialRead: true })
    .timeout({ seconds: 5 })
    .rotate()
    .resize(320, 320, { fit: "inside", withoutEnlargement: true });
  const bytes = await image.webp({ quality: 75, effort: 2 }).toBuffer();
  const { data, info } = await sharp(bytes).resize(100, 100, { fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { bytes, thumbhash: Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString("base64") };
}

export async function generateAssetThumbnail(bytes: Uint8Array, kind: string, filename: string) {
  if (kind === "image") return generateThumbnail(bytes);
  if (kind !== "model" || !process.env.MODEL_THUMBNAIL_URL || bytes.byteLength > 64 * 1024 * 1024) return undefined;
  const extension = filename.split(".").pop()?.toLowerCase();
  if (!extension || !["glb", "gltf", "obj", "stl", "fbx"].includes(extension)) return undefined;
  const response = await fetch(new URL("/render", process.env.MODEL_THUMBNAIL_URL), {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Model-Extension": extension,
      ...(process.env.MODEL_THUMBNAIL_SIGNING_KEY ? signRenderRequest(bytes, extension, process.env.MODEL_THUMBNAIL_SIGNING_KEY) : {}),
    },
    body: Buffer.from(bytes), signal: AbortSignal.timeout(45_000), redirect: "error",
  });
  if (!response.ok || response.headers.get("content-type") !== "image/png") throw new Error("Model renderer unavailable");
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 1024 * 1024) { await reader.cancel(); throw new Error("Renderer output too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return generateThumbnail(Buffer.concat(chunks));
}

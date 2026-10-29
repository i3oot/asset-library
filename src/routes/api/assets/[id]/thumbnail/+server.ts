import { requestedAsset } from "$lib/server/asset-response";
import { readFile } from "node:fs/promises";
import { error, type RequestHandler } from "@sveltejs/kit";
import { getThumbnailPath } from "$lib/server/assets";

export const GET: RequestHandler = async ({ params }) => {
  const asset = await requestedAsset(params.id, params.revision);
  if (!asset?.thumbhash) throw error(404, "Thumbnail not available");
  try { return new Response(await readFile(getThumbnailPath(asset.storedName)), { headers: { "Content-Type": "image/webp" } }); }
  catch { throw error(404, "Thumbnail not available"); }
};

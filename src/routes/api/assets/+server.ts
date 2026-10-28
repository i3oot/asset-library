import { json, type RequestHandler } from "@sveltejs/kit";
import {
  DuplicateAssetError,
  UploadConflictError, RevisionConflictError, replaceAssetFile, readAssetHistory,
  readAssets,
  saveAsset,
  toAssetView,
} from "$lib/server/assets";

function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export const GET: RequestHandler = async () => {
  const assets = await readAssets();
  return json({ assets: assets.map(toAssetView) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const form = await request.formData();
  const titleValue = form.get("title");
  const tagsValue = form.get("tags");
  const descriptionValue = form.get("description");
  const licensesValue = form.get("licenses");
  const sourceUrlValue = form.get("sourceUrl");
  const fileValue = form.get("file");

  if (typeof titleValue !== "string" || !titleValue.trim()) {
    return json({ error: "A title is required." }, { status: 400 });
  }

  if (!(fileValue instanceof File)) {
    return json({ error: "A file is required." }, { status: 400 });
  }

  const arrayBuffer = await fileValue.arrayBuffer();
  const tags = typeof tagsValue === "string" ? parseTags(tagsValue) : [];
  const description =
    typeof descriptionValue === "string" ? descriptionValue.trim() : "";
  const licenses =
    typeof licensesValue === "string" ? parseTags(licensesValue) : [];
  const sourceUrl =
    typeof sourceUrlValue === "string" ? sourceUrlValue.trim() : "";

  let record;
  try {
    const target = form.get('targetAssetId');
    const mode = form.get('mode');
    const expected = form.get('expectedRevision');
    const note = form.get('note');
    if (note !== null && (typeof note !== 'string' || note.length > 2000)) return json({ error: 'Change note is too long.' }, { status: 400 });
    const actor = locals.user ? { subject: locals.user.subject, issuer: locals.user.issuer, name: locals.user.name } : null;
    if (target !== null || mode !== null || expected !== null) {
      if (typeof target !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(target) || !['replace', 'new-version'].includes(String(mode))
        || typeof expected !== 'string' || !/^[1-9]\d{0,8}$/.test(expected)) return json({ error: 'Select an asset, upload mode and current history revision.' }, { status: 400 });
      record = await replaceAssetFile(target, { fileName: fileValue.name, mimeType: fileValue.type, size: fileValue.size, bytes: new Uint8Array(arrayBuffer) },
        { mode: mode as 'replace' | 'new-version', expectedRevision: Number(expected), actor, note: note as string | undefined });
      if (!record) return json({ error: 'Asset not found.' }, { status: 404 });
      return json({ asset: toAssetView(record) });
    }
    record = await saveAsset({
      title: titleValue.trim(),
      description,
      tags,
      licenses,
      sourceUrl,
      fileName: fileValue.name,
      mimeType: fileValue.type,
      size: fileValue.size,
      bytes: new Uint8Array(arrayBuffer),
      actor, note: note as string | undefined,
    });
  } catch (error) {
    if (error instanceof RevisionConflictError) return json({ error: error.message, code: 'revision_conflict' }, { status: 409 });
    if (error instanceof UploadConflictError) {
      const matches = await Promise.all(error.matches.map(async asset => ({ asset: toAssetView(asset), revision: (await readAssetHistory(asset.id))?.revisions[0]?.revision })));
      return json({ error: error.message, code: 'upload_conflict', duplicate: true, asset: matches[0]?.asset, matches }, { status: 409 });
    }
    if (error instanceof DuplicateAssetError) {
      return json(
        {
          error: `Duplicate upload skipped. Matching asset already exists: "${error.existingAsset.title}".`,
          duplicate: true,
          asset: toAssetView(error.existingAsset),
        },
        { status: 409 },
      );
    }

    console.error("Error saving asset:", error);
    return json({ error: "Failed to save asset." }, { status: 500 });
  }

  return json({ asset: toAssetView(record) }, { status: 201 });
};

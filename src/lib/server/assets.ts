import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase, type Database } from "$lib/server/database";
import { TextDecoder } from "node:util";
import type {
  AssetCategory,
  AssetPreviewKind,
  AssetRecord,
  AssetView,
  AssetRevision, RevisionActor, RevisionOperation,
} from "$lib/types";
import { safeSourceUrl } from "$lib/safe-url";
import { generateAssetThumbnail } from "$lib/server/thumbnails";
import { generateAutoMetadata } from "$lib/server/ai";

const dataRoot = path.join(process.cwd(), "data");
const uploadsDir = path.join(dataRoot, "uploads");
const metadataPath = path.join(dataRoot, "assets.json");

const modelExtensions = new Set([
  ".glb",
  ".gltf",
  ".obj",
  ".fbx",
  ".stl",
  ".blend",
]);
const textureExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tga",
  ".ktx2",
]);
const audioExtensions = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".aac",
]);
const shaderExtensions = new Set([
  ".glsl",
  ".vert",
  ".frag",
  ".wgsl",
  ".hlsl",
  ".shader",
]);
const scriptExtensions = new Set([
  ".js",
  ".ts",
  ".py",
  ".lua",
  ".json",
  ".cs",
  ".cpp",
  ".h",
]);
const textDecoder = new TextDecoder();

const DEFAULT_LICENSE = "Unknown";

type AssetRow = {
  id: string;
  title: string;
  description: string;
  tags_json: string;
  licenses_json: string;
  source_url: string;
  metadata_edited: number;
  upload_date: string;
  original_name: string;
  stored_name: string;
  file_type: string;
  hash: string | null;
  thumbhash: string | null;
  mime_type: string;
  size: number;
  category: string;
  preview_kind: string;
  width: number | null;
  height: number | null;
};

let db: Promise<Database> | undefined;
let storageReady: Promise<void> | undefined;

export class DuplicateAssetError extends Error {
  existingAsset: AssetRecord;

  constructor(existingAsset: AssetRecord) {
    super("Duplicate asset detected.");
    this.name = "DuplicateAssetError";
    this.existingAsset = existingAsset;
  }
}

export class UploadConflictError extends Error {
  constructor(public matches: AssetRecord[]) { super("Choose whether to replace the current version or save a new version."); }
}
export class RevisionConflictError extends Error {
  constructor() { super("The asset changed. Reload its history before uploading again."); }
}
type MutationOptions = { actor?: RevisionActor | null; note?: string; expectedRevision?: number };

async function lockAsset(database: Database, id: string): Promise<AssetRecord | undefined> {
  const result = await database.prepare('UPDATE assets SET id = id WHERE id = ?').run(id);
  if (!result.changes) return undefined;
  return rowToAssetRecord(await database.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow);
}
async function appendRevision(database: Database, record: AssetRecord, operation: RevisionOperation, options: MutationOptions = {}) {
  const latest = await database.prepare('SELECT revision, version FROM asset_revisions WHERE asset_id = ? ORDER BY revision DESC LIMIT 1').get(record.id) as { revision: number; version: number } | undefined;
  const revision = (latest?.revision ?? 0) + 1;
  const version = (latest?.version ?? 1) + (operation === 'new-version' ? 1 : 0);
  await database.prepare(`INSERT INTO asset_revisions (asset_id, revision, version, operation, created_at, actor_json, note, snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, revision, version, operation,
      operation === 'baseline' ? record.uploadDate : new Date().toISOString(),
      options.actor ? JSON.stringify(options.actor) : null, (options.note ?? '').trim().slice(0, 2000), JSON.stringify(record));
}
async function baseline(database: Database, record: AssetRecord, options: MutationOptions) {
  const latest = await database.prepare('SELECT MAX(revision) AS revision FROM asset_revisions WHERE asset_id = ?').get(record.id) as { revision: number | null };
  if (!latest.revision) await appendRevision(database, record, 'baseline');
  if (options.expectedRevision !== undefined && options.expectedRevision !== (latest.revision ?? 1)) throw new RevisionConflictError();
}
async function uploadMatches(database: Database, filename: string, hash: string) {
  const rows = await database.prepare('SELECT * FROM assets WHERE LOWER(original_name) = LOWER(?) OR hash = ? ORDER BY id').all(filename, hash) as AssetRow[];
  return rows.map(rowToAssetRecord);
}

function computeAssetHash(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensureAssetHashes(): Promise<void> {
  const database = await getDb();
  const rows = await database
    .prepare(
      "SELECT id, stored_name FROM assets WHERE hash IS NULL OR TRIM(hash) = ''",
    )
    .all() as Array<{ id: string; stored_name: string }>;

  if (rows.length === 0) {
    return;
  }

  const updateHash = database.prepare(
    "UPDATE assets SET hash = ? WHERE id = ?",
  );
  for (const row of rows) {
    try {
      const fileBytes = await readFile(getStoredFilePath(row.stored_name));
      await updateHash.run(computeAssetHash(fileBytes), row.id);
    } catch {
      // Ignore missing files and keep legacy records untouched.
    }
  }
}

function getDb(): Promise<Database> {
  if (!db) {
    db = createDatabase().catch((error) => { db = undefined; throw error; });
  }
  return db;
}

function parseStringArray(value: string, fallback: string[] = []): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return fallback;
    }
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return fallback;
  }
}

function normalizeImportedRecord(record: AssetRecord): AssetRecord {
  const normalizedLicenses = Array.isArray(record.licenses)
    ? record.licenses.map((license) => license.trim()).filter(Boolean)
    : [];

  return {
    ...record,
    fileType:
      typeof record.fileType === "string" && record.fileType.trim()
        ? record.fileType.trim().toLowerCase()
        : getFileType(record.originalName, record.mimeType),
    hash:
      typeof record.hash === "string" && record.hash.trim()
        ? record.hash.trim()
        : undefined,
    description:
      typeof record.description === "string" ? record.description.trim() : "",
    sourceUrl: safeSourceUrl(typeof record.sourceUrl === "string" ? record.sourceUrl : ""),
    licenses:
      normalizedLicenses.length > 0 ? normalizedLicenses : [DEFAULT_LICENSE],
    metadataEdited: record.metadataEdited ?? true,
    previewKind: getPreviewKind(
      record.category,
      record.originalName,
      record.mimeType,
    ),
  };
}

function rowToAssetRecord(row: AssetRow): AssetRecord {
  const category = (row.category || "other") as AssetCategory;
  const fallbackPreviewKind = getPreviewKind(
    category,
    row.original_name,
    row.mime_type,
  );

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags: parseStringArray(row.tags_json),
    licenses: (() => {
      const parsed = parseStringArray(row.licenses_json);
      return parsed.length > 0 ? parsed : [DEFAULT_LICENSE];
    })(),
    sourceUrl: safeSourceUrl(row.source_url),
    metadataEdited: Boolean(row.metadata_edited),
    uploadDate: row.upload_date,
    originalName: row.original_name,
    storedName: row.stored_name,
    fileType:
      typeof row.file_type === "string" && row.file_type.trim()
        ? row.file_type.trim().toLowerCase()
        : getFileType(row.original_name, row.mime_type),
    hash: row.hash?.trim() || undefined,
    thumbhash: row.thumbhash ?? undefined,
    mimeType: row.mime_type,
    size: Number(row.size),
    category,
    previewKind:
      row.preview_kind === "audio" ||
      row.preview_kind === "image" ||
      row.preview_kind === "model" ||
      row.preview_kind === "text" ||
      row.preview_kind === "none"
        ? row.preview_kind
        : fallbackPreviewKind,
    width: typeof row.width === "number" ? row.width : undefined,
    height: typeof row.height === "number" ? row.height : undefined,
  };
}

async function insertRecord(database: Database, record: AssetRecord, ignoreConflict = false): Promise<void> {
  await database
    .prepare(
      `
        INSERT INTO assets (
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          thumbhash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        ) VALUES (
          @id,
          @title,
          @description,
          @tags_json,
          @licenses_json,
          @source_url,
          @metadata_edited,
          @upload_date,
          @original_name,
          @stored_name,
          @file_type,
          @hash,
          @thumbhash,
          @mime_type,
          @size,
          @category,
          @preview_kind,
          @width,
          @height
        )
        ${ignoreConflict ? "ON CONFLICT DO NOTHING" : ""}
      `,
    )
    .run({
      id: record.id,
      title: record.title,
      description: record.description,
      tags_json: JSON.stringify(record.tags),
      licenses_json: JSON.stringify(record.licenses),
      source_url: record.sourceUrl,
      metadata_edited: record.metadataEdited ? 1 : 0,
      upload_date: record.uploadDate,
      original_name: record.originalName,
      stored_name: record.storedName,
      file_type: record.fileType,
      hash: record.hash ?? null,
      thumbhash: record.thumbhash ?? null,
      mime_type: record.mimeType,
      size: record.size,
      category: record.category,
      preview_kind: record.previewKind,
      width: record.width ?? null,
      height: record.height ?? null,
    });
}

async function migrateLegacyJsonIfNeeded(
  database: Database,
): Promise<void> {
  const countResult = await database
    .prepare("SELECT COUNT(*) AS count FROM assets")
    .get() as { count: number };
  if (Number(countResult.count) > 0) {
    return;
  }

  let raw: string;
  try {
    raw = await readFile(metadataPath, "utf8");
  } catch {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return;
  }

  const records = parsed
    .filter((entry): entry is AssetRecord => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as AssetRecord).id === "string" &&
        typeof (entry as AssetRecord).storedName === "string"
      );
    })
    .map((entry) => normalizeImportedRecord(entry));

  await database.transaction(async (transaction) => {
    for (const record of records) {
      await insertRecord(transaction, record, true);
    }
  });
}

async function ensureStorage(): Promise<void> {
  if (!storageReady) {
    storageReady = (async () => {
      await mkdir(dataRoot, { recursive: true });
      await mkdir(uploadsDir, { recursive: true });
      const database = await getDb();
      await migrateLegacyJsonIfNeeded(database);
    })();
  }

  try {
    await storageReady;
  } catch (error) {
    storageReady = undefined;
    throw error;
  }
}

function getCategory(fileName: string, mimeType: string): AssetCategory {
  const ext = path.extname(fileName).toLowerCase();
  if (mimeType.startsWith("audio/") || audioExtensions.has(ext)) return "audio";
  if (mimeType.startsWith("image/") || textureExtensions.has(ext))
    return "texture";
  if (modelExtensions.has(ext)) return "model";
  if (shaderExtensions.has(ext)) return "shader";
  if (scriptExtensions.has(ext) || mimeType.startsWith("text/"))
    return "script";
  return "other";
}

function getPreviewKind(
  category: AssetCategory,
  fileName: string,
  mimeType: string,
): AssetPreviewKind {
  if (category === "audio") return "audio";
  if (category === "texture") return "image";
  if (category === "shader" || category === "script") return "text";

  if (category === "model") {
    const ext = path.extname(fileName).toLowerCase();
    if ([".glb", ".gltf", ".obj", ".stl", ".fbx"].includes(ext)) {
      return "model";
    }
    if (mimeType === "model/gltf-binary" || mimeType === "model/gltf+json") {
      return "model";
    }
  }

  return "none";
}

function getAudioAttachmentFormat(
  fileName: string,
  mimeType: string,
): "mp3" | "wav" | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (
    mimeType === "audio/wav" ||
    mimeType === "audio/x-wav" ||
    ext === ".wav"
  ) {
    return "wav";
  }
  if (mimeType === "audio/mpeg" || ext === ".mp3") {
    return "mp3";
  }
  return undefined;
}

function getFileType(fileName: string, mimeType: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext.startsWith(".") && ext.length > 1) {
    return ext.slice(1);
  }

  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  if (!subtype) return "unknown";

  return subtype
    .replace("x-", "")
    .replace("svg+xml", "svg")
    .replace("jpeg", "jpg")
    .replace("mpeg", "mp3")
    .replace(/\+xml$/i, "");
}

export async function readAssets(): Promise<AssetRecord[]> {
  await ensureStorage();
  const database = await getDb();
  const rows = await database
    .prepare(
      `
        SELECT
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          thumbhash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        FROM assets
        ORDER BY upload_date DESC
      `,
    )
    .all() as AssetRow[];

  return rows.map(rowToAssetRecord);
}

export function toAssetView(record: AssetRecord): AssetView {
  // A stable asset id can point to new bytes; mounted image/model elements must reload too.
  const contentKey = record.hash ? `?hash=${encodeURIComponent(record.hash)}` : '';
  return {
    ...record,
    fileUrl: `/api/assets/${record.id}/file${contentKey}`,
    downloadUrl: `/api/assets/${record.id}/download`,
    textPreviewUrl: `/api/assets/${record.id}/text${contentKey}`,
    thumbnailUrl: record.thumbhash ? `/api/assets/${record.id}/thumbnail${contentKey}` : undefined,
  };
}

export async function saveAsset(params: {
  title: string;
  description?: string;
  tags: string[];
  licenses?: string[];
  sourceUrl?: string;
  fileName: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
  actor?: RevisionActor | null;
  note?: string;
}): Promise<AssetRecord> {
  await ensureStorage();
  const database = await getDb();
  const incomingHash = computeAssetHash(params.bytes);
  await ensureAssetHashes();
  const matches = await uploadMatches(database, params.fileName, incomingHash);
  if (matches.length) throw new UploadConflictError(matches);

  const id = randomUUID();
  const ext = path.extname(params.fileName);
  const storedName = `${id}-${randomUUID()}${ext}`;
  const category = getCategory(params.fileName, params.mimeType);
  const previewKind = getPreviewKind(
    category,
    params.fileName,
    params.mimeType,
  );

  // Attempt to read image dimensions for textures/images
  let width: number | undefined;
  let height: number | undefined;
  if (previewKind === "image") {
    try {
      const { default: sizeOf } = await import("image-size");
      const dims = sizeOf(Buffer.from(params.bytes));
      if (
        dims &&
        typeof dims.width === "number" &&
        typeof dims.height === "number"
      ) {
        width = dims.width;
        height = dims.height;
      }
    } catch (err) {
      // Non-fatal: if image-size isn't available or fails, continue without dims
      // eslint-disable-next-line no-console
      console.warn("Could not determine image dimensions:", err);
    }
  }

  const textSnippet =
    previewKind === "text"
      ? textDecoder.decode(params.bytes.slice(0, 4_000))
      : undefined;

  const autoMetadata = await generateAutoMetadata({
    title: params.title,
    originalName: params.fileName,
    category,
    mimeType: params.mimeType || "application/octet-stream",
    existingTags: params.tags,
    existingDescription: params.description ?? "",
    textSnippet,
    imageFile:
      category === "texture"
        ? {
            mimeType: params.mimeType || "application/octet-stream",
            bytes: params.bytes,
          }
        : undefined,
    audioFile:
      category === "audio"
        ? (() => {
            const format = getAudioAttachmentFormat(
              params.fileName,
              params.mimeType || "application/octet-stream",
            );
            if (!format) return undefined;
            return {
              format,
              bytes: params.bytes,
            };
          })()
        : undefined,
  });

  const normalizedLicenses = (params.licenses ?? [])
    .map((license) => license.trim())
    .filter(Boolean);
  const normalizedSourceUrl = safeSourceUrl(params.sourceUrl ?? "");
  const hasInitialMetadata =
    normalizedSourceUrl.length > 0 || normalizedLicenses.length > 0;

  const thumbnail = await generateAssetThumbnail(params.bytes, previewKind, params.fileName).catch(() => undefined);
  const record: AssetRecord = {
    id,
    title: params.title,
    description: autoMetadata.description,
    tags: autoMetadata.tags,
    licenses:
      normalizedLicenses.length > 0 ? normalizedLicenses : [DEFAULT_LICENSE],
    sourceUrl: normalizedSourceUrl,
    metadataEdited: hasInitialMetadata,
    uploadDate: new Date().toISOString(),
    originalName: params.fileName,
    storedName,
    fileType: getFileType(
      params.fileName,
      params.mimeType || "application/octet-stream",
    ),
    hash: incomingHash,
    thumbhash: thumbnail?.thumbhash,
    mimeType: params.mimeType || "application/octet-stream",
    size: params.size,
    category,
    previewKind,
    width,
    height,
  };

  try {
    await writeFile(getStoredFilePath(storedName), params.bytes);
    if (thumbnail) await writeFile(getThumbnailPath(storedName), thumbnail.bytes);
    await database.transaction(async transaction => {
      // Serialize conflict detection and insertion, including concurrent same-name uploads.
      if (process.env.DATABASE_BACKEND === 'postgres') await transaction.prepare('LOCK TABLE assets IN SHARE ROW EXCLUSIVE MODE').run();
      const matches = await uploadMatches(transaction, params.fileName, incomingHash);
      if (matches.length) throw new UploadConflictError(matches);
      await insertRecord(transaction, record);
      await appendRevision(transaction, record, 'created', params);
    });
  } catch (errorValue) {
    await deleteStoredFiles(storedName);

    const message =
      errorValue instanceof Error ? errorValue.message : String(errorValue);
    if ((message.includes("UNIQUE constraint failed: assets.hash") || (errorValue as { code?: string }).code === "23505")) {
      const existing = await database
        .prepare(
          `
            SELECT
              id,
              title,
              description,
              tags_json,
              licenses_json,
              source_url,
              metadata_edited,
              upload_date,
              original_name,
              stored_name,
              file_type,
              hash,
              thumbhash,
              mime_type,
              size,
              category,
              preview_kind,
              width,
              height
            FROM assets
            WHERE hash = ?
            LIMIT 1
          `,
        )
        .get(incomingHash) as AssetRow | undefined;
      if (existing) {
        throw new DuplicateAssetError(rowToAssetRecord(existing));
      }
    }
    throw errorValue;
  }

  return record;
}

export async function getAssetById(
  id: string,
): Promise<AssetRecord | undefined> {
  await ensureStorage();
  const database = await getDb();
  const row = await database
    .prepare(
      `
        SELECT
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          thumbhash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        FROM assets
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(id) as AssetRow | undefined;

  return row ? rowToAssetRecord(row) : undefined;
}

export async function updateAssetMetadata(
  id: string,
  updates: {
    title: string;
    description: string;
    tags: string[];
    licenses: string[];
    sourceUrl: string;
  },
  options: MutationOptions = {},
): Promise<AssetRecord | undefined> {
  await ensureStorage();
  const database = await getDb();
  return database.transaction(async transaction => {
    const current = await lockAsset(transaction, id);
    if (!current) return undefined;
    await baseline(transaction, current, options);
    const result = await transaction
      .prepare(
        `
          UPDATE assets
          SET
            title = @title,
            description = @description,
            tags_json = @tags_json,
            licenses_json = @licenses_json,
            source_url = @source_url,
            metadata_edited = 1
          WHERE id = @id
        `,
      )
      .run({
        id,
        title: updates.title,
        description: updates.description,
        tags_json: JSON.stringify(updates.tags),
        licenses_json: JSON.stringify(updates.licenses),
        source_url: safeSourceUrl(updates.sourceUrl),
      });

    if (result.changes === 0) {
      return undefined;
    }

    const updated = rowToAssetRecord(await transaction.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow);
    await appendRevision(transaction, updated, 'metadata', options);
    return updated;
  });
}

export async function replaceAssetFile(
  id: string,
  replacement: {
    fileName: string;
    mimeType: string;
    size: number;
    bytes: Uint8Array;
  },
  options: MutationOptions & { mode?: "replace" | "new-version" } = {},
): Promise<AssetRecord | undefined> {
  await ensureStorage();
  const database = await getDb();
  await ensureAssetHashes();

  const currentRow = await database
    .prepare(
      `
        SELECT
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          thumbhash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        FROM assets
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(id) as AssetRow | undefined;
  if (!currentRow) {
    return undefined;
  }

  const incomingHash = computeAssetHash(replacement.bytes);
  const duplicateRow = await database
    .prepare(
      `
        SELECT
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          thumbhash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        FROM assets
        WHERE hash = ? AND id != ?
        LIMIT 1
      `,
    )
    .get(incomingHash, id) as AssetRow | undefined;
  const duplicate = duplicateRow ? rowToAssetRecord(duplicateRow) : undefined;
  if (duplicate) {
    throw new DuplicateAssetError(duplicate);
  }

  const ext = path.extname(replacement.fileName);
  const storedName = `${id}-${randomUUID()}${ext}`;
  const category = getCategory(replacement.fileName, replacement.mimeType);
  const previewKind = getPreviewKind(
    category,
    replacement.fileName,
    replacement.mimeType,
  );

  let width: number | undefined;
  let height: number | undefined;
  if (previewKind === "image") {
    try {
      const { default: sizeOf } = await import("image-size");
      const dims = sizeOf(Buffer.from(replacement.bytes));
      if (
        dims &&
        typeof dims.width === "number" &&
        typeof dims.height === "number"
      ) {
        width = dims.width;
        height = dims.height;
      }
    } catch {
      // Ignore image dimension probe failures.
    }
  }

  const thumbnail = await generateAssetThumbnail(replacement.bytes, previewKind, replacement.fileName).catch(() => undefined);

  const uploadDate = new Date().toISOString();
  try {
    await writeFile(getStoredFilePath(storedName), replacement.bytes);
    if (thumbnail) await writeFile(getThumbnailPath(storedName), thumbnail.bytes);
    await database.transaction(async transaction => {
      const latest = await lockAsset(transaction, id);
      if (!latest) throw new RevisionConflictError();
      await baseline(transaction, latest, options);
      await transaction
      .prepare(
        `
          UPDATE assets
          SET
            original_name = @original_name,
            stored_name = @stored_name,
            file_type = @file_type,
            hash = @hash,
            thumbhash = @thumbhash,
            mime_type = @mime_type,
            size = @size,
            category = @category,
            preview_kind = @preview_kind,
            width = @width,
            height = @height,
            upload_date = @upload_date,
            metadata_edited = 0
          WHERE id = @id
        `,
      )
      .run({
        id,
        original_name: replacement.fileName,
        stored_name: storedName,
        file_type: getFileType(
          replacement.fileName,
          replacement.mimeType || "application/octet-stream",
        ),
        hash: incomingHash,
        thumbhash: thumbnail?.thumbhash ?? null,
        mime_type: replacement.mimeType || "application/octet-stream",
        size: replacement.size,
        category,
        preview_kind: previewKind,
        width: width ?? null,
        height: height ?? null,
        upload_date: uploadDate,
      });
      const updated = rowToAssetRecord(await transaction.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow);
      await appendRevision(transaction, updated, options.mode === 'new-version' ? 'new-version' : 'replaced', options);
    });
  } catch (errorValue) {
    await deleteStoredFiles(storedName);
    const message =
      errorValue instanceof Error ? errorValue.message : String(errorValue);
    if ((message.includes("UNIQUE constraint failed: assets.hash") || (errorValue as { code?: string }).code === "23505")) {
      const existing = await database
        .prepare(
          `
            SELECT
              id,
              title,
              description,
              tags_json,
              licenses_json,
              source_url,
              metadata_edited,
              upload_date,
              original_name,
              stored_name,
              file_type,
              hash,
              thumbhash,
              mime_type,
              size,
              category,
              preview_kind,
              width,
              height
            FROM assets
            WHERE hash = ? AND id != ?
            LIMIT 1
          `,
        )
        .get(incomingHash, id) as AssetRow | undefined;
      if (existing) {
        throw new DuplicateAssetError(rowToAssetRecord(existing));
      }
    }
    throw errorValue;
  }

  return getAssetById(id);
}

export async function deleteAsset(id: string): Promise<boolean> {
  await ensureStorage();
  const database = await getDb();
  const storedNames = await database.transaction(async transaction => {
    const current = await lockAsset(transaction, id);
    if (!current) return undefined;
    const rows = await transaction.prepare('SELECT snapshot_json FROM asset_revisions WHERE asset_id = ?').all(id) as Array<{ snapshot_json: string }>;
    const names = new Set([current.storedName, ...rows.map(row => (JSON.parse(row.snapshot_json) as AssetRecord).storedName)]);
    await transaction.prepare('DELETE FROM asset_revisions WHERE asset_id = ?').run(id);
    await transaction.prepare('DELETE FROM assets WHERE id = ?').run(id);
    return names;
  });
  if (!storedNames) return false;
  await Promise.all([...storedNames].map(deleteStoredFiles));
  return true;
}

export async function readAssetHistory(id: string, offset = 0, limit = 50): Promise<{ total: number; revisions: AssetRevision[] } | undefined> {
  await ensureStorage();
  const database = await getDb();
  // Lazily establish an accurate baseline for pre-history installations.
  return database.transaction(async transaction => {
    const current = await lockAsset(transaction, id);
    if (!current) return undefined;
    await baseline(transaction, current, {});
    const count = await transaction.prepare('SELECT COUNT(*) AS total FROM asset_revisions WHERE asset_id = ?').get(id) as { total: number };
    const rows = await transaction.prepare('SELECT * FROM asset_revisions WHERE asset_id = ? ORDER BY revision DESC LIMIT ? OFFSET ?').all(id, limit, offset) as Array<{
      revision: number; version: number; operation: RevisionOperation; created_at: string; actor_json: string | null; note: string; snapshot_json: string;
    }>;
    return { total: Number(count.total), revisions: rows.map(row => {
      const record = JSON.parse(row.snapshot_json) as AssetRecord;
      const base = `/api/assets/${encodeURIComponent(id)}/versions/${row.revision}`;
      return { revision: row.revision, version: row.version, operation: row.operation, createdAt: row.created_at,
        actor: row.actor_json ? JSON.parse(row.actor_json) as RevisionActor : null, note: row.note,
        asset: { ...record, storedName: '', fileUrl: base + '/file', downloadUrl: base + '/download', textPreviewUrl: base + '/text', thumbnailUrl: record.thumbhash ? base + '/thumbnail' : undefined } };
    }) };
  });
}
export async function getAssetRevision(id: string, revision: number): Promise<AssetRecord | undefined> {
  await ensureStorage();
  const row = await (await getDb()).prepare('SELECT snapshot_json FROM asset_revisions WHERE asset_id = ? AND revision = ?').get(id, revision) as { snapshot_json: string } | undefined;
  return row ? JSON.parse(row.snapshot_json) as AssetRecord : undefined;
}

export function getStoredFilePath(storedName: string): string {
  if (!storedName || storedName !== path.basename(storedName) || /[\\/\0]/.test(storedName)) {
    throw new Error("Invalid stored asset name");
  }
  return path.join(uploadsDir, storedName);
}

export function getThumbnailPath(storedName: string): string {
  return getStoredFilePath(storedName) + ".thumbnail.webp";
}

async function deleteStoredFiles(storedName: string): Promise<void> {
  await Promise.all([
    rm(getStoredFilePath(storedName), { force: true }),
    rm(getThumbnailPath(storedName), { force: true }),
  ]);
}

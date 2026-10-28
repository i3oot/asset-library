export type AssetCategory =
  | "audio"
  | "texture"
  | "shader"
  | "script"
  | "model"
  | "other";
export type AssetPreviewKind = "audio" | "image" | "model" | "text" | "none";

export interface AssetRecord {
  id: string;
  title: string;
  description: string;
  tags: string[];
  licenses: string[];
  sourceUrl: string;
  metadataEdited: boolean;
  uploadDate: string;
  originalName: string;
  storedName: string;
  fileType: string;
  hash?: string;
  thumbhash?: string;
  mimeType: string;
  size: number;
  category: AssetCategory;
  previewKind: AssetPreviewKind;
  width?: number;
  height?: number;
}

export interface AssetView extends AssetRecord {
  fileUrl: string;
  downloadUrl: string;
  textPreviewUrl: string;
  thumbnailUrl?: string;
}

export type RevisionActor = { subject: string; issuer: string; name: string };
export type RevisionOperation = 'baseline' | 'created' | 'metadata' | 'new-version' | 'replaced';
export interface AssetRevision {
  revision: number;
  version: number;
  operation: RevisionOperation;
  createdAt: string;
  actor: RevisionActor | null;
  note: string;
  asset: AssetView;
}

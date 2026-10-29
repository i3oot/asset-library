import type { AssetView, AssetRevision } from "$lib/types";

export type AiConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  readOnly?: boolean;
  timeoutMs: number;
  temperature: number;
  disableThinking: boolean;
  reasoningEffort:
    | ""
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
  customInstruction: string;
};

export type AssetUpdatePayload = {
  title: string;
  description: string;
  tags: string[];
  licenses: string[];
  sourceUrl: string;
};

export type ApiErrorPayload = {
  error?: string;
  duplicate?: boolean;
  code?: string;
  matches?: UploadMatch[];
};
export type UploadMatch = { asset: AssetView; revision: number };
export type UploadDecision = { targetAssetId: string; expectedRevision: number; mode: 'replace' | 'new-version'; note: string };
export class UploadConflict extends Error {
  constructor(public matches: UploadMatch[]) { super('Choose how to save this upload.'); }
}

export class AssetLibraryApiService {
  async listAssets(): Promise<AssetView[]> {
    const response = await fetch("/api/assets");
    if (!response.ok) {
      throw new Error("Failed to load assets.");
    }

    const payload = (await response.json()) as { assets: AssetView[] };
    return payload.assets;
  }

  async uploadAsset(
    form: FormData,
    fileName: string,
    onProgress: (loadedBytes: number, totalBytes: number) => void,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/assets");

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress(event.loaded, event.total);
      };

      xhr.onerror = () => {
        reject(new Error(`Upload failed for ${fileName}.`));
      };

      xhr.onabort = () => {
        reject(new Error(`Upload cancelled for ${fileName}.`));
      };

      xhr.onload = () => {
        let payload: ApiErrorPayload = {};
        if (xhr.responseText) {
          try {
            payload = JSON.parse(xhr.responseText) as ApiErrorPayload;
          } catch {
            // Ignore parse errors and use fallback message.
          }
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(1, 1);
          resolve();
          return;
        }

        reject(payload.code === 'upload_conflict' && payload.matches?.length
          ? new UploadConflict(payload.matches) : new Error(payload.error || `Upload failed for ${fileName}.`));
      };

      xhr.send(form);
    });
  }

  async getAiConfig(): Promise<AiConfig | null> {
    const response = await fetch("/api/integrations/ai");
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { config: AiConfig };
    return payload.config;
  }

  async saveAiConfig(config: AiConfig): Promise<AiConfig> {
    const response = await fetch("/api/integrations/ai", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });

    const payload = (await response.json()) as {
      config?: AiConfig;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(payload.error || "Failed to save AI settings.");
    }

    if (!payload.config) {
      throw new Error("Failed to save AI settings.");
    }

    return payload.config;
  }

  async replaceAssetFile(
    assetId: string,
    file: File,
    decision: UploadDecision,
  ): Promise<ApiErrorPayload | null> {
    const form = new FormData();
    form.set("file", file);
    form.set('mode', decision.mode);
    form.set('expectedRevision', String(decision.expectedRevision));
    form.set('note', decision.note);
    form.set('title', file.name);
    form.set('targetAssetId', assetId);

    const response = await fetch('/api/assets', {
      method: "POST",
      body: form,
    });

    const payload = (await response.json()) as ApiErrorPayload;
    if (!response.ok) {
      throw new Error(payload.error || "Failed to replace file.");
    }

    return payload;
  }

  async updateAsset(
    assetId: string,
    update: AssetUpdatePayload,
  ): Promise<void> {
    const response = await fetch(`/api/assets/${assetId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "Failed to save metadata.");
    }
  }

  async deleteAsset(assetId: string): Promise<void> {
    const response = await fetch(`/api/assets/${assetId}/delete`, {
      method: "POST",
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete' }),
    });

    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "Failed to delete asset.");
    }
  }

  async getTextPreview(textPreviewUrl: string): Promise<string | null> {
    const response = await fetch(textPreviewUrl);
    if (!response.ok) return null;

    const payload = (await response.json()) as { text: string };
    return payload.text;
  }

  async history(assetId: string, offset = 0): Promise<{ total: number; revisions: AssetRevision[] }> {
    const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/versions?offset=${offset}&limit=50`);
    if (!response.ok) throw new Error('Failed to load version history.');
    return response.json();
  }
}

<script lang="ts">
  import type { PageData } from "./$types";
  export let data: PageData;

  import Icon from "$lib/components/Icon.svelte";
  import Fuse from "fuse.js";
  import { toast } from "svelte-sonner";
  import { onMount } from "svelte";
  import { mountWebMcp, type WebMcpStatus } from "$lib/services/webmcp";
  import { replaceState } from "$app/navigation";
  import { browser } from "$app/env";
  import * as publicEnv from "$app/env/public";
  import type { AssetCategory, AssetView, AssetRevision } from "$lib/types";
  import AssetCard from "$lib/components/AssetCard.svelte";
  import Button from "$lib/components/Button.svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import FilterPane from "$lib/components/FilterPane.svelte";
  import Input from "$lib/components/Input.svelte";
  import SearchField from "$lib/components/SearchField.svelte";
  import SelectField from "$lib/components/SelectField.svelte";
  import TagPicker from "$lib/components/TagPicker.svelte";
  import TitleIconReel from "$lib/components/TitleIconReel.svelte";
  import {
    AssetLibraryApiService,
    type AiConfig, UploadConflict, type UploadDecision, type UploadMatch,
  } from "$lib/services/asset-library-api";
  import {
    SourceLicensePrefillHelper,
    UNITY_ASSET_STORE_LICENSE,
  } from "$lib/services/source-license-prefill";

  const FILTER_QUERY_KEYS = {
    todo: "todo",
    categories: "categories",
    tags: "tags",
    licenses: "licenses",
    sort: "sort",
  } as const;
  const GITHUB_REPO_URL = "https://github.com/Kellojo/asset-library";
  let historyAssetId: string | null = null;
  let historyRows: AssetRevision[] = [];
  let historyTotal = 0;
  let historyBusy = false;
  let historyError = '';
  let uploadChoice: { file: File; matches: UploadMatch[] } | null = null;
  let uploadChoiceTarget = '';
  let uploadChangeNote = '';
  let resolveUploadChoice: ((choice: UploadDecision | null) => void) | null = null;
  let decisionTail = Promise.resolve();
  let webMcpStatus: WebMcpStatus | 'checking' = 'checking';
  let settingsSection: 'ai' | 'webmcp' = 'ai';
  $: webMcpStatusLabel = webMcpStatus === 'available' ? 'Available'
    : webMcpStatus === 'unsupported' ? 'Unsupported browser'
    : webMcpStatus === 'failed' ? 'Registration failed' : 'Checking support';
  function notifyAgentSupport(status: WebMcpStatus): void {
    webMcpStatus = status;
    if (status === 'available') return;
    const key = `asset-library:webmcp-notice:${status}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, 'shown');
    } catch { /* Storage restrictions must not prevent the library from loading. */ }
    toast.info(status === 'unsupported' ? 'Agent tools unavailable' : 'Agent tools could not connect', {
      id: 'asset-library-webmcp-support',
      description: status === 'unsupported'
        ? 'This browser doesn’t support WebMCP yet. Use a compatible browser to connect your agent.'
        : 'Your library is ready, but this browser couldn’t register its agent tools. Reload to try again.',
      class: 'toast agent-support-toast',
      position: 'bottom-right',
      closeButton: true,
      duration: 9000,
      action: { label: 'Connection details', onClick: () => { settingsSection = 'webmcp'; aiSettingsOpen = true; } },
    });
  }
  const SORT_MODE_OPTIONS = [
    { value: "best-match", label: "Best Match" },
    { value: "newest", label: "Newest" },
    { value: "oldest", label: "Oldest" },
    { value: "title-asc", label: "Title A-Z" },
    { value: "size-desc", label: "Largest Size" },
    { value: "needs-metadata", label: "Needs Metadata First" },
  ] as const;
  const AI_REASONING_EFFORT_OPTIONS = [
    { value: "", label: "Auto (unset)" },
    { value: "none", label: "None" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "XHigh" },
  ] as const;
  type SortMode = (typeof SORT_MODE_OPTIONS)[number]["value"];
  const DEFAULT_SORT_MODE: SortMode = "best-match";
  const THEME_STORAGE_KEY = "asset-library-theme";
  const DEFAULT_UPLOAD_PARALLELISM = 4;
  const MAX_UPLOAD_PARALLELISM = 16;
  type ThemeMode = "light" | "dark";

  const categoryOrder: AssetCategory[] = [
    "model",
    "texture",
    "audio",
    "shader",
    "script",
    "other",
  ];
  const categoryIconByType: Record<AssetCategory, string> = {
    model: "mdi:cube-outline",
    texture: "mdi:image-outline",
    audio: "mdi:music-note-outline",
    shader: "mdi:shimmer",
    script: "mdi:code-tags",
    other: "mdi:file-outline",
  };
  const commonLicenseOptions = [
    "Unknown",
    "Self created",
    "CC0",
    "CC BY 4.0",
    "CC BY-SA 4.0",
    "Royalty Free",
    "Editorial Use Only",
    "All Rights Reserved",
    UNITY_ASSET_STORE_LICENSE,
  ];
  type QueuedUpload = {
    file: File;
    sourceUrl: string;
    licenses: string[];
  };

  let assets: AssetView[] = [];
  let loading = true;

  let isDragging = false;
  let pageDragDepth = 0;
  let editingAssetId: string | null = null;
  let deletingAssetId: string | null = null;
  let editTitle = "";
  let editTags: string[] = [];
  let editLicenses: string[] = [];
  let editSourceUrl = "";
  let editDescription = "";
  let saveInProgress = false;
  let replaceInProgress = false;

  let uploadQueue: QueuedUpload[] = [];
  let queueRunning = false;
  let uploadBatchTotal = 0;
  let uploadProcessedCount = 0;
  let importPrefillOpen = false;
  let importPrefillSourceUrl = "";
  let importPrefillLicenses: string[] = [];
  let pendingImportFiles: File[] = [];
  let importPrefillDialogRef: { requestClose: () => void } | null = null;

  let searchQuery = "";
  let showTodoOnly = false;
  let sortMode: SortMode = DEFAULT_SORT_MODE;
  let selectedCategories: AssetCategory[] = [];
  let selectedFilterTags: string[] = [];
  let selectedFilterLicenses: string[] = [];
  let filterTagQuery = "";
  let filterLicenseQuery = "";
  let didHydrateFiltersFromUrl = false;
  let aiSettingsOpen = false;
  let aiSaving = false;
  let themeMode: ThemeMode = "dark";
  let uploadInputEl: HTMLInputElement | null = null;
  let replaceInputEl: HTMLInputElement | null = null;
  let showBackToTop = false;
  let editDialogRef: { requestClose: () => void } | null = null;
  let aiDialogRef: { requestClose: () => void } | null = null;
  let aiConfig: AiConfig = {
    enabled: false,
    baseUrl: "http://127.0.0.1:1234",
    model: "",
    apiKey: "",
    timeoutMs: 120000,
    temperature: 0.2,
    disableThinking: false,
    reasoningEffort: "",
    customInstruction: "",
  };
  const api = new AssetLibraryApiService();
  const sourceLicensePrefillHelper = new SourceLicensePrefillHelper();
  const uploadParallelism = parseUploadParallelism(
    publicEnv.PUBLIC_UPLOAD_PARALLELISM,
  );
  const textPreviews: Record<string, string> = {};
  let fuzzyMatchedAssetIds: Set<string> | null = null;
  let fuzzyRankByAssetId: Map<string, number> | null = null;

  function parseUploadParallelism(rawValue: string | undefined): number {
    const parsed = Number.parseInt(rawValue ?? "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return DEFAULT_UPLOAD_PARALLELISM;
    }
    return Math.min(parsed, MAX_UPLOAD_PARALLELISM);
  }

  $: normalizedSearchQuery = searchQuery.trim();
  $: {
    const q = normalizedSearchQuery;
    if (!q) {
      fuzzyMatchedAssetIds = null;
      fuzzyRankByAssetId = null;
    } else {
      const fuse = new Fuse(assets, {
        threshold: 0.35,
        ignoreLocation: true,
        minMatchCharLength: 2,
        keys: [
          { name: "title", weight: 0.35 },
          { name: "description", weight: 0.25 },
          { name: "tags", weight: 0.2 },
          { name: "fileType", weight: 0.15 },
          { name: "originalName", weight: 0.15 },
          { name: "category", weight: 0.05 },
        ],
      });

      const results = fuse.search(q);
      fuzzyMatchedAssetIds = new Set(results.map((result) => result.item.id));
      fuzzyRankByAssetId = new Map(
        results.map((result, index) => [result.item.id, index]),
      );
    }
  }

  $: visibleAssets = (() => {
    const filteredAssets = assets.filter((asset) => {
      const matchesQuery =
        !normalizedSearchQuery || !!fuzzyMatchedAssetIds?.has(asset.id);
      const matchesTodo = !showTodoOnly || !asset.metadataEdited;
      const matchesCategory =
        selectedCategories.length === 0 ||
        selectedCategories.includes(asset.category);
      const matchesTags = selectedFilterTags.every((selectedTag) =>
        asset.tags.some(
          (assetTag) => assetTag.toLowerCase() === selectedTag.toLowerCase(),
        ),
      );
      const matchesLicenses = selectedFilterLicenses.every((selectedLicense) =>
        (asset.licenses ?? []).some(
          (assetLicense) =>
            assetLicense.toLowerCase() === selectedLicense.toLowerCase(),
        ),
      );
      return (
        matchesQuery &&
        matchesTodo &&
        matchesCategory &&
        matchesTags &&
        matchesLicenses
      );
    });

    return [...filteredAssets].sort((left, right) => {
      if (sortMode === "oldest") {
        return Date.parse(left.uploadDate) - Date.parse(right.uploadDate);
      }

      if (sortMode === "title-asc") {
        return left.title.localeCompare(right.title, undefined, {
          sensitivity: "base",
        });
      }

      if (sortMode === "size-desc") {
        return right.size - left.size;
      }

      if (sortMode === "needs-metadata") {
        if (left.metadataEdited !== right.metadataEdited) {
          return left.metadataEdited ? 1 : -1;
        }
        return Date.parse(right.uploadDate) - Date.parse(left.uploadDate);
      }

      if (sortMode === "best-match") {
        if (normalizedSearchQuery && fuzzyRankByAssetId) {
          const leftRank =
            fuzzyRankByAssetId.get(left.id) ?? Number.MAX_SAFE_INTEGER;
          const rightRank =
            fuzzyRankByAssetId.get(right.id) ?? Number.MAX_SAFE_INTEGER;

          if (leftRank !== rightRank) {
            return leftRank - rightRank;
          }
        }

        return Date.parse(right.uploadDate) - Date.parse(left.uploadDate);
      }

      return Date.parse(right.uploadDate) - Date.parse(left.uploadDate);
    });
  })();

  $: todoCount = assets.filter((asset) => !asset.metadataEdited).length;
  $: allKnownTags = Array.from(
    new Set(
      assets.flatMap((asset) =>
        asset.tags.map((tag) => tag.trim()).filter(Boolean),
      ),
    ),
  ).sort((a, b) => a.localeCompare(b));
  $: categoryCounts = categoryOrder.map((category) => ({
    category,
    count: assets.filter((asset) => asset.category === category).length,
  }));
  $: tagCountMap = assets.reduce<Record<string, number>>((counts, asset) => {
    for (const tag of asset.tags) {
      const key = tag.trim().toLowerCase();
      if (!key) continue;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, {});
  $: licenseCountMap = assets.reduce<Record<string, number>>(
    (counts, asset) => {
      for (const license of asset.licenses ?? []) {
        const key = license.trim().toLowerCase();
        if (!key) continue;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    },
    {},
  );
  $: normalizedFilterTagQuery = filterTagQuery.trim().toLowerCase();
  $: normalizedFilterLicenseQuery = filterLicenseQuery.trim().toLowerCase();
  $: filteredTagRows = allKnownTags
    .filter(
      (tag) =>
        !normalizedFilterTagQuery ||
        tag.toLowerCase().includes(normalizedFilterTagQuery),
    )
    .map((tag) => ({
      tag,
      count: tagCountMap[tag.toLowerCase()] ?? 0,
      selected: selectedFilterTags.some(
        (selected) => selected.toLowerCase() === tag.toLowerCase(),
      ),
    }));
  $: filteredLicenseRows = allKnownLicenses
    .filter(
      (license) =>
        !!licenseCountMap[license.toLowerCase()] &&
        (!normalizedFilterLicenseQuery ||
          license.toLowerCase().includes(normalizedFilterLicenseQuery)),
    )
    .map((license) => ({
      license,
      count: licenseCountMap[license.toLowerCase()] ?? 0,
      selected: selectedFilterLicenses.some(
        (selected) => selected.toLowerCase() === license.toLowerCase(),
      ),
    }));
  $: allKnownLicenses = Array.from(
    new Set(
      [
        ...commonLicenseOptions,
        ...assets.flatMap((asset) =>
          (asset.licenses ?? [])
            .map((license) => license.trim())
            .filter(Boolean),
        ),
      ]
        .map((license) => license.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));
  $: uploadPendingCount = Math.max(0, uploadBatchTotal - uploadProcessedCount);
  $: {
    const suggestedLicenses =
      sourceLicensePrefillHelper.getPrefillLicensesForSourceUrl(
        importPrefillSourceUrl,
      );
    if (suggestedLicenses.length > 0) {
      const existingLicenses = new Set(
        importPrefillLicenses.map((license) => license.trim().toLowerCase()),
      );
      const missingLicenses = suggestedLicenses.filter(
        (license) => !existingLicenses.has(license.toLowerCase()),
      );

      if (missingLicenses.length > 0) {
        importPrefillLicenses = [...importPrefillLicenses, ...missingLicenses];
      }
    }
  }

  function hasFilePayload(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    return !!types && Array.from(types).includes("Files");
  }

  function titleFromFileName(fileName: string): string {
    const base = fileName.replace(/\.[^/.]+$/, "");
    return base.trim() || fileName;
  }

  function formatCategoryLabel(category: AssetCategory): string {
    return `${category.slice(0, 1).toUpperCase()}${category.slice(1)}`;
  }

  function parseListParam(
    searchParams: URLSearchParams,
    key: string,
  ): string[] {
    const value = searchParams.get(key);
    if (!value) return [];

    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function syncFiltersFromUrl(): void {
    if (!browser) return;

    const url = new URL(globalThis.location.href);
    const categoriesFromUrl = parseListParam(
      url.searchParams,
      FILTER_QUERY_KEYS.categories,
    );
    const tagsFromUrl = parseListParam(
      url.searchParams,
      FILTER_QUERY_KEYS.tags,
    );
    const licensesFromUrl = parseListParam(
      url.searchParams,
      FILTER_QUERY_KEYS.licenses,
    );
    const knownCategorySet = new Set(categoryOrder);

    selectedCategories = categoriesFromUrl.filter(
      (category): category is AssetCategory =>
        knownCategorySet.has(category as AssetCategory),
    );

    selectedFilterTags = Array.from(
      new Map(tagsFromUrl.map((tag) => [tag.toLowerCase(), tag])).values(),
    );
    selectedFilterLicenses = Array.from(
      new Map(
        licensesFromUrl.map((license) => [license.toLowerCase(), license]),
      ).values(),
    );

    const todoParam = url.searchParams.get(FILTER_QUERY_KEYS.todo);
    showTodoOnly = todoParam === "1" || todoParam === "true";

    const sortParam = url.searchParams.get(FILTER_QUERY_KEYS.sort);
    sortMode = SORT_MODE_OPTIONS.some((option) => option.value === sortParam)
      ? (sortParam as SortMode)
      : DEFAULT_SORT_MODE;
  }

  function applyTheme(theme: ThemeMode): void {
    if (!browser) return;
    themeMode = theme;
    document.documentElement.dataset.theme = theme;
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }

  function toggleTheme(): void {
    applyTheme(themeMode === "dark" ? "light" : "dark");
  }

  function openGitHubRepo(): void {
    if (!browser) return;
    globalThis.open(GITHUB_REPO_URL, "_blank", "noopener,noreferrer");
  }

  function onWindowScroll(): void {
    if (!browser) return;
    showBackToTop = globalThis.scrollY > 420;
  }

  function scrollToTop(): void {
    if (!browser) return;
    globalThis.scrollTo({ top: 0, behavior: "smooth" });
  }

  function initializeTheme(): void {
    if (!browser) return;

    const savedTheme = globalThis.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "light" || savedTheme === "dark") {
      applyTheme(savedTheme);
      return;
    }

    const prefersDark = globalThis.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    applyTheme(prefersDark ? "dark" : "light");
  }

  function syncUrlFromFilters(): void {
    if (!browser || !didHydrateFiltersFromUrl) return;

    const url = new URL(globalThis.location.href);

    url.searchParams.delete(FILTER_QUERY_KEYS.todo);
    url.searchParams.delete(FILTER_QUERY_KEYS.categories);
    url.searchParams.delete(FILTER_QUERY_KEYS.tags);
    url.searchParams.delete(FILTER_QUERY_KEYS.licenses);
    url.searchParams.delete(FILTER_QUERY_KEYS.sort);

    if (showTodoOnly) {
      url.searchParams.set(FILTER_QUERY_KEYS.todo, "1");
    }

    if (selectedCategories.length > 0) {
      url.searchParams.set(
        FILTER_QUERY_KEYS.categories,
        selectedCategories.join(","),
      );
    }

    if (selectedFilterTags.length > 0) {
      url.searchParams.set(
        FILTER_QUERY_KEYS.tags,
        selectedFilterTags.join(","),
      );
    }

    if (selectedFilterLicenses.length > 0) {
      url.searchParams.set(
        FILTER_QUERY_KEYS.licenses,
        selectedFilterLicenses.join(","),
      );
    }

    if (sortMode !== DEFAULT_SORT_MODE) {
      url.searchParams.set(FILTER_QUERY_KEYS.sort, sortMode);
    }

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    const currentUrl = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;
    if (nextUrl !== currentUrl) {
      replaceState(nextUrl, globalThis.history.state);
    }
  }

  function queueFiles(files: File[]): void {
    if (!files.length) return;
    importPrefillSourceUrl = "";
    importPrefillLicenses = [];
    pendingImportFiles = files;
    importPrefillOpen = true;
  }

  function cancelImportPrefill(): void {
    importPrefillOpen = false;
    pendingImportFiles = [];
    importPrefillSourceUrl = "";
    importPrefillLicenses = [];
  }

  function closeImportPrefillDialog(): void {
    if (importPrefillDialogRef) {
      importPrefillDialogRef.requestClose();
      return;
    }
    cancelImportPrefill();
  }

  function queuePendingImports(): void {
    const files = pendingImportFiles;
    if (!files.length) return;

    const sourceUrl = importPrefillSourceUrl.trim();
    const licenses = [...importPrefillLicenses];
    const queuedUploads = files.map((file) => ({
      file,
      sourceUrl,
      licenses,
    }));

    const queuedBefore = uploadQueue.length;
    if (!queueRunning && queuedBefore === 0) {
      uploadBatchTotal = 0;
      uploadProcessedCount = 0;
    }

    uploadQueue = [...uploadQueue, ...queuedUploads];
    uploadBatchTotal += files.length;
    toast.success(
      `Queued ${files.length} file${files.length === 1 ? "" : "s"} for upload.`,
    );

    pendingImportFiles = [];
    importPrefillOpen = false;
    void processUploadQueue();
  }

  async function askUploadChoice(file: File, matches: UploadMatch[]): Promise<UploadDecision | null> {
    const previous = decisionTail;
    let release!: () => void;
    decisionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      uploadChoice = { file, matches };
      uploadChoiceTarget = matches.length === 1 ? matches[0].asset.id : '';
      uploadChangeNote = '';
      return await new Promise<UploadDecision | null>(resolve => { resolveUploadChoice = resolve; });
    } finally { release(); }
  }
  function finishUploadChoice(mode: UploadDecision['mode'] | null): void {
    const target = uploadChoice?.matches.find(match => match.asset.id === uploadChoiceTarget);
    if (mode && !target) return;
    resolveUploadChoice?.(mode && target ? { targetAssetId: target.asset.id, expectedRevision: target.revision, mode, note: uploadChangeNote } : null);
    resolveUploadChoice = null; uploadChoice = null;
  }
  async function uploadSingleFile(upload: QueuedUpload): Promise<void> {
    const { file, sourceUrl, licenses } = upload;
    const form = new FormData();
    form.set("title", titleFromFileName(file.name));
    form.set("tags", ""); form.set("sourceUrl", sourceUrl);
    form.set("licenses", licenses.join(",")); form.set("file", file);
    // Ask before sending a potentially large same-name file. The server rechecks races/content duplicates.
    const known = (await api.listAssets()).filter(asset => asset.originalName.toLowerCase() === file.name.toLowerCase());
    let matches = await Promise.all(known.map(async asset => ({ asset, revision: (await api.history(asset.id)).revisions[0].revision })));
    while (true) {
      if (matches.length) {
        const decision = await askUploadChoice(file, matches);
        if (!decision) throw new Error(`Upload cancelled: ${file.name}`);
        form.set('targetAssetId', decision.targetAssetId); form.set('mode', decision.mode);
        form.set('expectedRevision', String(decision.expectedRevision)); form.set('note', decision.note);
      }
      try { await api.uploadAsset(form, file.name, () => {}); return; }
      catch (error) {
        if (!(error instanceof UploadConflict)) throw error;
        matches = error.matches;
      }
    }
  }

  async function openHistory(assetId: string): Promise<void> {
    historyAssetId = assetId; historyRows = []; historyTotal = 0; historyError = '';
    await loadMoreHistory();
  }
  async function loadMoreHistory(): Promise<void> {
    const assetId = historyAssetId;
    if (!assetId || historyBusy) return;
    historyBusy = true;
    try {
      const page = await api.history(assetId, historyRows.length);
      if (historyAssetId === assetId) { historyRows = [...historyRows, ...page.revisions]; historyTotal = page.total; }
    } catch { historyError = 'Could not load history. Please try again.'; }
    finally { historyBusy = false; }
  }

  async function processUploadQueue(): Promise<void> {
    if (queueRunning) return;
    queueRunning = true;

    let uploadedCount = 0;
    const worker = async (): Promise<void> => {
      while (uploadQueue.length > 0) {
        const nextUpload = uploadQueue[0];
        uploadQueue = uploadQueue.slice(1);

        try {
          await uploadSingleFile(nextUpload);
          uploadedCount += 1;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Upload failed.";
          if (message.toLowerCase().includes("duplicate")) {
            toast.warning(message);
          } else {
            toast.error(message);
          }
        } finally {
          uploadProcessedCount += 1;
        }
      }
    };

    const workerCount = Math.min(uploadParallelism, uploadQueue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    queueRunning = false;
    if (uploadedCount > 0) {
      toast.success(
        `Uploaded ${uploadedCount} file${uploadedCount === 1 ? "" : "s"}.`,
      );
      await loadAssets();
    }
  }

  async function loadAssets(): Promise<void> {
    loading = true;
    try {
      assets = await api.listAssets();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to load assets.",
      );
    } finally {
      loading = false;
    }
  }

  async function loadAiConfig(): Promise<void> {
    try {
      const config = await api.getAiConfig();
      if (!config) return;
      aiConfig = config;
    } catch {
      // Optional integration; ignore transient failures.
    }
  }

  async function saveAiConfig(): Promise<void> {
    aiSaving = true;

    try {
      aiConfig = await api.saveAiConfig(aiConfig as AiConfig);
      aiSettingsOpen = false;
      toast.success(
        aiConfig.enabled ? "AI auto metadata enabled." : "AI settings saved.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save AI settings.",
      );
    } finally {
      aiSaving = false;
    }
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    pageDragDepth = 0;
    isDragging = false;
    queueFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  function onWindowDragEnter(event: DragEvent): void {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    pageDragDepth += 1;
    isDragging = true;
  }

  function onWindowDragOver(event: DragEvent): void {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    isDragging = true;
  }

  function onWindowDragLeave(event: DragEvent): void {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    pageDragDepth = Math.max(0, pageDragDepth - 1);
    if (pageDragDepth === 0) isDragging = false;
  }

  function startEdit(asset: AssetView): void {
    editingAssetId = asset.id;
    editTitle = asset.title;
    editTags = [...asset.tags];
    editLicenses =
      asset.licenses && asset.licenses.length > 0
        ? [...asset.licenses]
        : ["Unknown"];
    editSourceUrl = asset.sourceUrl ?? "";
    editDescription = asset.description ?? "";
  }

  function cancelEdit(): void {
    editingAssetId = null;
    editTitle = "";
    editTags = [];
    editLicenses = [];
    editSourceUrl = "";
    editDescription = "";
  }

  function toggleFilterTag(rawTag: string): void {
    const tag = rawTag.trim();
    if (!tag) return;
    const isSelected = selectedFilterTags.some(
      (current) => current.toLowerCase() === tag.toLowerCase(),
    );
    if (isSelected) {
      selectedFilterTags = selectedFilterTags.filter(
        (current) => current.toLowerCase() !== tag.toLowerCase(),
      );
    } else {
      selectedFilterTags = [...selectedFilterTags, tag];
    }
  }

  function toggleFilterLicense(rawLicense: string): void {
    const license = rawLicense.trim();
    if (!license) return;
    const isSelected = selectedFilterLicenses.some(
      (current) => current.toLowerCase() === license.toLowerCase(),
    );
    if (isSelected) {
      selectedFilterLicenses = selectedFilterLicenses.filter(
        (current) => current.toLowerCase() !== license.toLowerCase(),
      );
    } else {
      selectedFilterLicenses = [...selectedFilterLicenses, license];
    }
  }

  function toggleCategory(category: AssetCategory): void {
    if (selectedCategories.includes(category)) {
      selectedCategories = selectedCategories.filter(
        (item) => item !== category,
      );
      return;
    }
    selectedCategories = [...selectedCategories, category];
  }

  function clearAllFilters(): void {
    selectedCategories = [];
    selectedFilterTags = [];
    selectedFilterLicenses = [];
    filterTagQuery = "";
    filterLicenseQuery = "";
    showTodoOnly = false;
  }

  function onFilterTagQueryKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      const candidate = filteredTagRows[0]?.tag || "";
      if (candidate) toggleFilterTag(candidate);
      return;
    }

    if (
      event.key === "Backspace" &&
      !filterTagQuery &&
      selectedFilterTags.length > 0
    ) {
      event.preventDefault();
      selectedFilterTags = selectedFilterTags.slice(0, -1);
      return;
    }

    if (event.key === "Escape") {
      filterTagQuery = "";
    }
  }

  function onFilterLicenseQueryKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      const candidate = filteredLicenseRows[0]?.license || "";
      if (candidate) toggleFilterLicense(candidate);
      return;
    }

    if (
      event.key === "Backspace" &&
      !filterLicenseQuery &&
      selectedFilterLicenses.length > 0
    ) {
      event.preventDefault();
      selectedFilterLicenses = selectedFilterLicenses.slice(0, -1);
      return;
    }

    if (event.key === "Escape") {
      filterLicenseQuery = "";
    }
  }

  function saveActiveEdit(): void {
    if (!editingAssetId) return;
    void saveMetadata(editingAssetId);
  }

  function triggerReplaceFilePicker(): void {
    replaceInputEl?.click();
  }

  async function replaceActiveAssetFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";

    if (!editingAssetId || !file) return;

    replaceInProgress = true;

    try {
      const assetId = editingAssetId;
      const asset = assets.find(asset => asset.id === assetId);
      if (!asset) return;
      const history = await api.history(assetId);
      const decision = await askUploadChoice(file, [{ asset, revision: history.revisions[0].revision }]);
      if (!decision) return;
      await api.replaceAssetFile(assetId, file, decision);

      toast.success("File update saved in history. Please review metadata.");
      await loadAssets();
    } catch (errorValue) {
      toast.error(
        errorValue instanceof Error
          ? errorValue.message
          : "Failed to replace file.",
      );
    } finally {
      replaceInProgress = false;
    }
  }

  function closeEditDialog(): void {
    if (editDialogRef) {
      editDialogRef.requestClose();
      return;
    }
    cancelEdit();
  }

  function onSettingsTabKeyDown(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    settingsSection = event.key === 'Home' ? 'ai' : event.key === 'End' ? 'webmcp'
      : settingsSection === 'ai' ? 'webmcp' : 'ai';
    document.getElementById(`settings-${settingsSection}-tab`)?.focus();
  }

  function closeAiDialog(): void {
    if (aiDialogRef) {
      aiDialogRef.requestClose();
      return;
    }
    aiSettingsOpen = false;
  }

  function onWindowKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && editingAssetId) {
      closeEditDialog();
    }
  }

  async function saveMetadata(assetId: string): Promise<void> {
    if (editLicenses.length === 0) {
      toast.error("At least one license is required.");
      return;
    }

    saveInProgress = true;
    try {
      await api.updateAsset(assetId, {
        title: editTitle,
        description: editDescription,
        tags: editTags,
        licenses: editLicenses,
        sourceUrl: editSourceUrl,
      });
      toast.success("Metadata updated.");
      closeEditDialog();
      await loadAssets();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save metadata.",
      );
    } finally {
      saveInProgress = false;
    }
  }

  async function removeAsset(asset: AssetView): Promise<void> {
    const shouldDelete = globalThis.confirm(
      `Delete "${asset.title}" and all its historical versions? This cannot be undone.`,
    );
    if (!shouldDelete) return;

    deletingAssetId = asset.id;
    try {
      await api.deleteAsset(asset.id);
      if (editingAssetId === asset.id) cancelEdit();
      toast.success("Asset deleted.");
      await loadAssets();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete asset.",
      );
    } finally {
      deletingAssetId = null;
    }
  }

  async function loadTextPreview(asset: AssetView): Promise<void> {
    if (textPreviews[asset.id] !== undefined) return;
    const text = await api.getTextPreview(asset.textPreviewUrl);
    if (text === null) return;
    textPreviews[asset.id] = text;
  }

  function formatTimeAgo(iso: string): string {
    const uploadedAt = new Date(iso).getTime();
    const now = Date.now();
    const diffMs = Math.max(0, now - uploadedAt);

    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diffMs < minute) return "just now";
    if (diffMs < hour) {
      const minutes = Math.floor(diffMs / minute);
      return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }
    if (diffMs < day) {
      const hours = Math.floor(diffMs / hour);
      return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    }

    const days = Math.floor(diffMs / day);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  }

  onMount(loadAssets);
  onMount(() => mountWebMcp({ changed: loadAssets, show: startEdit }, notifyAgentSupport));
  onMount(loadAiConfig);
  onMount(initializeTheme);
  onMount(onWindowScroll);
  onMount(() => {
    syncFiltersFromUrl();
    didHydrateFiltersFromUrl = true;

    const onPopState = (): void => {
      syncFiltersFromUrl();
    };
    globalThis.addEventListener("popstate", onPopState);
    return () => {
      globalThis.removeEventListener("popstate", onPopState);
    };
  });

  $: {
    // Explicitly reference dependencies so Svelte reruns this block on filter changes.
    didHydrateFiltersFromUrl;
    showTodoOnly;
    selectedCategories;
    selectedFilterTags;
    selectedFilterLicenses;
    sortMode;
    syncUrlFromFilters();
  }
</script>

<style>
  .asset-history { padding-left: 1.5rem; }
  .asset-history li { border-bottom: 1px solid #8885; padding: 1rem 0; }
  .asset-history dt { font-weight: 600; }
  .asset-history a { color: inherit; text-decoration: underline; }
  .asset-history dd { margin: 0 0 0.5rem; overflow-wrap: anywhere; }
</style>

<svelte:window
  on:dragenter={onWindowDragEnter}
  on:dragover={onWindowDragOver}
  on:dragleave={onWindowDragLeave}
  on:drop={onDrop}
  on:keydown={onWindowKeyDown}
  on:scroll={onWindowScroll}
/>

<main class="assetlib-shell">
  <nav class="assetlib-accountbar" aria-label="Account and settings">
    <div class="assetlib-topbar-actions">
      <Button
        onclick={toggleTheme}
        title="Toggle light/dark mode"
        ariaLabel="Toggle light/dark mode"
        iconOnly={true}
      >
        <Icon
          icon={themeMode === "dark"
            ? "mdi:weather-sunny"
            : "mdi:weather-night"}
          width="1rem"
          height="1rem"
          aria-hidden="true"
        />
      </Button>

      <Button onclick={openGitHubRepo} title="Open repository on GitHub" ariaLabel="Open repository on GitHub" iconOnly>
        <Icon icon="mdi:github" width="1rem" height="1rem" aria-hidden="true" />
      </Button>

      <Button
        onclick={() => { settingsSection = 'ai'; aiSettingsOpen = true; }}
        title="Settings"
        ariaLabel="Settings"
        iconOnly
      >
        <Icon icon="mdi:cog-outline" width="1rem" height="1rem" aria-hidden="true" />
      </Button>
      <span class="assetlib-webmcp-status" data-status={webMcpStatus}>
        <Button
          onclick={() => { settingsSection = 'webmcp'; aiSettingsOpen = true; }}
          title={`WebMCP: ${webMcpStatusLabel}`}
          ariaLabel={`WebMCP status: ${webMcpStatusLabel}`}
          iconOnly
        >
          <Icon icon="mdi:connection" width="1rem" height="1rem" aria-hidden="true" />
        </Button>
        <span class="assetlib-webmcp-dot" aria-hidden="true"></span>
      </span>
    </div>
    {#if data.auth?.enabled && data.auth.user}
      <div class="assetlib-account">
        <span>{data.auth.user.name}</span>
        <form method="POST" action="/auth/logout">
          <Button type="submit">Sign out</Button>
        </form>
      </div>
    {/if}
  </nav>

  {#if isDragging}
    <div class="assetlib-drop-overlay" aria-hidden="true">
      <div class="assetlib-drop-overlay-card">Drop files to queue upload</div>
    </div>
  {/if}

  <header class="assetlib-glass assetlib-topbar">
    <div class="assetlib-title-wrap">
      <TitleIconReel
        categories={categoryOrder}
        iconByCategory={categoryIconByType}
      />
      <h1>Asset Library</h1>
      <div class="assetlib-title-stats">
        <span>{assets.length}</span>
        {#if uploadPendingCount > 0}
          <span class="active assetlib-upload-indicator" aria-live="polite">
            <Icon
              icon="codex:loader"
              width="1rem"
              height="1rem"
              aria-hidden="true"
            />
            Uploading {uploadPendingCount} left
          </span>
        {/if}
      </div>
    </div>
    <div class="assetlib-topbar-actions">
      <input
        bind:this={uploadInputEl}
        type="file"
        multiple
        class="assetlib-file-input-hidden"
        on:change={(event) => {
          const target = event.currentTarget as HTMLInputElement;
          queueFiles(Array.from(target.files ?? []));
          target.value = "";
        }}
      />
      <Button
        onclick={() => {
          uploadInputEl?.click();
        }}
      >
        <Icon icon="mdi:upload" width="1rem" height="1rem" aria-hidden="true" />
        Import Files
      </Button>
    </div>
  </header>

  <section class="assetlib-glass assetlib-library">
    <div class="assetlib-library-layout">
      <FilterPane
        bind:showTodoOnly
        {todoCount}
        {categoryCounts}
        {selectedCategories}
        {categoryIconByType}
        {formatCategoryLabel}
        {toggleCategory}
        {clearAllFilters}
        {selectedFilterTags}
        {selectedFilterLicenses}
        {filteredTagRows}
        {toggleFilterTag}
        bind:filterTagQuery
        {onFilterTagQueryKeyDown}
        {filteredLicenseRows}
        {toggleFilterLicense}
        bind:filterLicenseQuery
        {onFilterLicenseQueryKeyDown}
      />

      <div class="assetlib-library-main">
        <div class="assetlib-tools">
          <SearchField
            bind:value={searchQuery}
            placeholder="Search title, description, tag, file type, file, category"
          />
          <SelectField bind:value={sortMode} options={SORT_MODE_OPTIONS} />
        </div>

        {#if loading}
          <p>Loading assets...</p>
        {:else if assets.length === 0}
          <p>No assets yet, get started by dragging and dropping files here.</p>
        {:else if visibleAssets.length === 0}
          <p>No assets match this filter.</p>
        {:else}
          <div class="assetlib-grid">
            {#each visibleAssets as asset}
              <AssetCard
                {asset}
                textPreview={textPreviews[asset.id]}
                onEdit={startEdit}
                onLoadText={loadTextPreview}
                {formatSize}
                {formatTimeAgo}
              />
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </section>

  {#if editingAssetId}
    <Dialog
      bind:this={editDialogRef}
      ariaLabel="Edit asset metadata"
      title="Edit Metadata"
      onClose={cancelEdit}
    >
      <label class="assetlib-modal-label">
        <span>Title</span>
        <Input bind:value={editTitle} minlength={2} maxlength={120} />
      </label>

      <input
        bind:this={replaceInputEl}
        type="file"
        class="assetlib-file-input-hidden"
        on:change={replaceActiveAssetFile}
      />

      <label class="assetlib-modal-label">
        <span>Tags</span>
        <TagPicker
          bind:values={editTags}
          allOptions={allKnownTags}
          emptyPlaceholder="Add tags"
          filledPlaceholder="Add another tag"
          dropdownAriaLabel="Tag suggestions"
          optionPrefix="#"
        />
      </label>

      <label class="assetlib-modal-label">
        <span>Description</span>
        <textarea
          bind:value={editDescription}
          class="assetlib-description-input"
          placeholder="Short description"
          rows="3"
          maxlength="240"
        ></textarea>
      </label>

      <label class="assetlib-modal-label">
        <span>Source URL</span>
        <Input
          bind:value={editSourceUrl}
          type="url"
          placeholder="https://example.com/..."
        />
      </label>

      <label class="assetlib-modal-label">
        <span>Licenses</span>
        <TagPicker
          bind:values={editLicenses}
          allOptions={allKnownLicenses}
          emptyPlaceholder="Add licenses"
          filledPlaceholder="Add another license"
          dropdownAriaLabel="License suggestions"
        />
      </label>

      {#snippet actions()}
        <Button onclick={() => editingAssetId && openHistory(editingAssetId)}>Version History</Button>
        <Button
          disabled={saveInProgress ||
            replaceInProgress ||
            deletingAssetId === editingAssetId}
          onclick={triggerReplaceFilePicker}
        >
          {replaceInProgress ? "Saving file..." : "Upload File Update"}
        </Button>
        <Button
          variant="delete"
          disabled={saveInProgress ||
            replaceInProgress ||
            deletingAssetId === editingAssetId}
          onclick={() => {
            const asset = assets.find((item) => item.id === editingAssetId);
            if (!asset) return;
            void removeAsset(asset);
          }}
        >
          {deletingAssetId === editingAssetId ? "Deleting..." : "Delete"}
        </Button>
        <Button
          variant="emphasized"
          onclick={saveActiveEdit}
          disabled={saveInProgress || replaceInProgress}
        >
          {saveInProgress ? "Saving..." : "Save"}
        </Button>
        <Button onclick={closeEditDialog} disabled={replaceInProgress}
          >Cancel</Button
        >
      {/snippet}
    </Dialog>
  {/if}

  {#if historyAssetId}
    <Dialog ariaLabel="Asset version history" title="Version History" scrollable onClose={() => { historyAssetId = null; }}>
      <p>Every file and metadata update is recorded. Replacements retain the version number; new versions increment it.</p>
      {#if historyError}<p role="alert">{historyError}</p>{/if}
      <ol class="asset-history">
        {#each historyRows as entry (entry.revision)}
          <li>
            <h3>Version {entry.version} · {entry.operation} · Change #{entry.revision}</h3>
            <p>{new Date(entry.createdAt).toLocaleString()} · {entry.actor?.name ?? 'Unknown / authentication disabled'}</p>
            {#if entry.note}<p>{entry.note}</p>{/if}
            {#if entry.asset.thumbnailUrl}<img src={entry.asset.thumbnailUrl} alt="Preview of version {entry.version}" width="160" />{/if}
            <dl>
              <dt>File</dt><dd>{entry.asset.originalName} · {formatSize(entry.asset.size)}</dd>
              <dt>Title</dt><dd>{entry.asset.title}</dd>
              <dt>Description</dt><dd>{entry.asset.description || '—'}</dd>
              <dt>Tags</dt><dd>{entry.asset.tags.join(', ') || '—'}</dd>
              <dt>Licenses</dt><dd>{entry.asset.licenses.join(', ')}</dd>
              <dt>Source</dt><dd>{entry.asset.sourceUrl || '—'}</dd>
              <dt>SHA-256</dt><dd >{entry.asset.hash || 'Unavailable'}</dd>
            </dl>
            <a href={entry.asset.downloadUrl}>Download this revision</a>
          </li>
        {/each}
      </ol>
      {#if historyBusy}<p role="status">Loading history…</p>{/if}
      {#snippet actions()}
        {#if historyRows.length < historyTotal}<Button disabled={historyBusy} onclick={loadMoreHistory}>Load More Changes</Button>{/if}
        {#if historyError}<Button disabled={historyBusy} onclick={loadMoreHistory}>Retry</Button>{/if}
        <Button onclick={() => { historyAssetId = null; }}>Close History</Button>
      {/snippet}
    </Dialog>
  {/if}

  {#if uploadChoice}
    <Dialog ariaLabel="Choose upload version" title="Save File Update" scrollable onClose={() => finishUploadChoice(null)}>
      <p><strong>{uploadChoice.file.name}</strong>: choose the asset and how to save this update.</p>
      <label class="assetlib-modal-label">
        <span>Existing asset</span>
        <select bind:value={uploadChoiceTarget}>
          <option value="" disabled>Select an asset</option>
          {#each uploadChoice.matches as match}
            <option value={match.asset.id}>{match.asset.title} ({match.asset.originalName})</option>
          {/each}
        </select>
      </label>
      <label class="assetlib-modal-label"><span>Change note (optional)</span><textarea bind:value={uploadChangeNote} maxlength="2000" rows="2"></textarea></label>
      <p>New Version increases the version number. Replace Current keeps the version number. Both retain the previous file in history and preserve existing metadata.</p>
      {#snippet actions()}
        <Button variant="emphasized" disabled={!uploadChoiceTarget} onclick={() => finishUploadChoice('new-version')}>Save New Version</Button>
        <Button disabled={!uploadChoiceTarget} onclick={() => finishUploadChoice('replace')}>Replace Current</Button>
        <Button onclick={() => finishUploadChoice(null)}>Cancel Upload</Button>
      {/snippet}
    </Dialog>
  {/if}

  {#if aiSettingsOpen}
    <Dialog
      bind:this={aiDialogRef}
      ariaLabel="Settings"
      title="Settings"
      wide
      scrollable
      onClose={() => {
        aiSettingsOpen = false;
      }}
    >
      <div class="assetlib-settings-layout">
        <div class="assetlib-settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
          <button
            id="settings-ai-tab"
            type="button"
            role="tab"
            aria-selected={settingsSection === 'ai'}
            aria-controls="settings-ai-panel"
            tabindex={settingsSection === 'ai' ? 0 : -1}
            on:keydown={onSettingsTabKeyDown}
            on:click={() => settingsSection = 'ai'}
          >
            <Icon icon="mingcute:file-ai-fill" width="1rem" height="1rem" aria-hidden="true" />
            AI
          </button>
          <button
            id="settings-webmcp-tab"
            type="button"
            role="tab"
            aria-selected={settingsSection === 'webmcp'}
            aria-controls="settings-webmcp-panel"
            tabindex={settingsSection === 'webmcp' ? 0 : -1}
            on:keydown={onSettingsTabKeyDown}
            on:click={() => settingsSection = 'webmcp'}
          >
            <Icon icon="mdi:connection" width="1rem" height="1rem" aria-hidden="true" />
            WebMCP
          </button>
        </div>
        {#if settingsSection === 'ai'}
          <div tabindex="0" id="settings-ai-panel" class="assetlib-settings-content" role="tabpanel" aria-labelledby="settings-ai-tab">
            <h3>AI</h3>
            <p class="assetlib-muted">
              Connect an OpenAI-compatible endpoint to auto-generate tags and a short
              description on upload.
            </p>

            {#if aiConfig.readOnly}
              <p class="assetlib-muted">AI settings are managed by the server.</p>
            {/if}
            <fieldset disabled={aiConfig.readOnly} style="border: 0; padding: 0; margin: 0; min-width: 0;">
              <label class="assetlib-toggle">
                <input type="checkbox" bind:checked={aiConfig.enabled} />
                <span>Enable auto metadata</span>
              </label>

              <label class="assetlib-modal-label">
                <span>Base URL</span>
                <Input
                  bind:value={aiConfig.baseUrl}
                  placeholder="http://127.0.0.1:1234"
                />
              </label>

              <label class="assetlib-modal-label">
                <span>Model</span>
                <Input bind:value={aiConfig.model} placeholder="qwen2.5-7b-instruct" />
              </label>

              <label class="assetlib-modal-label">
                <span>API Key (optional)</span>
                <Input
                  bind:value={aiConfig.apiKey}
                  type="password"
                  placeholder={aiConfig.apiKeyConfigured ? "Key configured; leave blank to keep it" : "leave empty for local dev"}
                />
              </label>

              <label class="assetlib-modal-label">
                <span>Timeout (ms)</span>
                <Input
                  type="number"
                  min="1000"
                  step="500"
                  bind:value={aiConfig.timeoutMs}
                />
              </label>

              <label class="assetlib-modal-label">
                <span>Temperature</span>
                <Input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  bind:value={aiConfig.temperature}
                />
              </label>

              <label class="assetlib-modal-label">
                <span>Reasoning Effort</span>
                <SelectField
                  bind:value={aiConfig.reasoningEffort}
                  options={AI_REASONING_EFFORT_OPTIONS}
                  disabled={aiConfig.disableThinking}
                  minWidth="100%"
                />
              </label>

              <label class="assetlib-toggle">
                <input type="checkbox" bind:checked={aiConfig.disableThinking} />
                <span>Disable model thinking (force reasoning effort = none)</span>
              </label>

              <label class="assetlib-modal-label">
                <span>Custom Instruction (optional)</span>
                <textarea
                  bind:value={aiConfig.customInstruction}
                  class="assetlib-description-input"
                  placeholder="Example: prioritize game-ready surface keywords and avoid brand names"
                  rows="3"
                  maxlength="1000"
                ></textarea>
              </label>
            </fieldset>
          </div>
        {:else}
          <div tabindex="0" id="settings-webmcp-panel" class="assetlib-settings-content" role="tabpanel" aria-labelledby="settings-webmcp-tab">
            <h3>WebMCP</h3>
            <p class="assetlib-webmcp-state" data-status={webMcpStatus}>{webMcpStatusLabel}</p>
            {#if webMcpStatus === 'available'}
              <p>This page has registered seven tools for your agent: search, asset details, version history, text previews, opening assets, metadata updates and text imports.</p>
              <p>Browser tools are ready. An agent still needs a compatible browser connector or a local WebMCP-to-MCP bridge to use them.</p>
            {:else if webMcpStatus === 'unsupported'}
              <p>This browser does not expose WebMCP. Enable WebMCP in a compatible browser and reload the library.</p>
            {:else if webMcpStatus === 'failed'}
              <p>The browser could not register the library tools. Reload the page to try again.</p>
            {:else}
              <p>Checking whether this browser can register the library tools.</p>
            {/if}
            <p>For Codex CLI, connect a local MCP bridge to this signed-in browser tab. Your normal library login is used; no additional app server is needed.</p>
            <a class="assetlib-settings-guide" href="https://developer.chrome.com/docs/devtools/application/webmcp#automation_and_agents" target="_blank" rel="noopener noreferrer">Chrome bridge setup guide</a>
          </div>
        {/if}
      </div>

      {#snippet actions()}
        {#if settingsSection === 'ai'}
          <Button variant="emphasized" onclick={saveAiConfig} disabled={aiSaving || aiConfig.readOnly}>
            {aiSaving ? "Saving..." : "Save"}
          </Button>
        {/if}
        <Button onclick={closeAiDialog}>Close</Button>
      {/snippet}
    </Dialog>
  {/if}

  {#if importPrefillOpen}
    <Dialog
      bind:this={importPrefillDialogRef}
      ariaLabel="Bulk import prefills"
      title="Import Prefills"
      onClose={cancelImportPrefill}
    >
      <p class="assetlib-muted">
        Apply shared metadata to {pendingImportFiles.length} file{pendingImportFiles.length ===
        1
          ? ""
          : "s"} before queueing upload.
      </p>

      <label class="assetlib-modal-label">
        <span>Source URL (optional)</span>
        <Input
          bind:value={importPrefillSourceUrl}
          type="url"
          placeholder="https://example.com/..."
        />
      </label>

      <label class="assetlib-modal-label">
        <span>Licenses (optional)</span>
        <TagPicker
          bind:values={importPrefillLicenses}
          allOptions={allKnownLicenses}
          emptyPlaceholder="Add licenses"
          filledPlaceholder="Add another license"
          dropdownAriaLabel="License suggestions"
        />
      </label>

      {#snippet actions()}
        <Button variant="emphasized" onclick={queuePendingImports}
          >Queue Files</Button
        >
        <Button onclick={closeImportPrefillDialog}>Cancel</Button>
      {/snippet}
    </Dialog>
  {/if}

  {#if showBackToTop}
    <Button
      onclick={scrollToTop}
      extraClass="assetlib-back-to-top"
      title="Back to top"
      ariaLabel="Back to top"
      iconOnly={true}
    >
      <Icon icon="mdi:arrow-up" width="1rem" height="1rem" aria-hidden="true" />
    </Button>
  {/if}
</main>

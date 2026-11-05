import { computed, signal } from "@preact/signals";
import {
  embeddingCoverage,
  getProjection,
  listDatasets,
  type EmbeddingCoverage,
} from "../core/db";
import {
  defaultSettings,
  loadSettings,
  mergeSettings,
  modelKey,
  saveSettings,
  type Settings,
} from "../core/settings";
import type { Dataset, Job } from "../core/types";
import { onMessage, startConnection } from "./api";

export type View = "import" | "explore" | "cluster" | "map" | "models";
const VIEWS: View[] = ["import", "explore", "cluster", "map", "models"];

const viewFromHash = (): View => {
  const hash = location.hash.slice(1);
  if (hash === "settings") return "models";
  return VIEWS.includes(hash as View) ? (hash as View) : "explore";
};

export const view = signal<View>(viewFromHash());
export const settings = signal<Settings>(defaultSettings());
export const datasets = signal<Dataset[]>([]);
export const coverage = signal<EmbeddingCoverage[]>([]);
export const hasProjection = signal(false);
export const jobs = signal<Job[]>([]);
export const notice = signal<{ text: string; kind: "danger" | "success" } | null>(null);
/** Bumped whenever stored data changed, for views that read it. */
export const dataVersion = signal(0);
export const loaded = signal(false);

const NARROW = "(max-width: 991.98px)";
const COLLAPSED_KEY = "sidebarCollapsed";

function storedCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Below the breakpoint the sidebar is a drawer, which starts closed and isn't remembered. */
const narrow = signal(matchMedia(NARROW).matches);
const drawerOpen = signal(false);
const sidebarCollapsed = signal(storedCollapsed());
export const sidebarVisible = computed(() =>
  narrow.value ? drawerOpen.value : !sidebarCollapsed.value,
);

export function toggleSidebar() {
  if (narrow.value) {
    drawerOpen.value = !drawerOpen.value;
    return;
  }
  sidebarCollapsed.value = !sidebarCollapsed.value;
  try {
    localStorage.setItem(COLLAPSED_KEY, sidebarCollapsed.value ? "1" : "0");
  } catch {
    // The preference just won't survive a reload.
  }
}

export function closeDrawer() {
  drawerOpen.value = false;
}

export const activeDataset = computed(
  () => datasets.value.find((d) => d.id === settings.value.activeDatasetId) ?? null,
);
export const activeModelKey = computed(() => modelKey(settings.value.model));
export const activeCoverage = computed(
  () => coverage.value.find((c) => c.modelKey === activeModelKey.value)?.count ?? 0,
);
export const runningJobs = computed(() => jobs.value.filter((j) => j.status === "running"));

export function go(next: View) {
  location.hash = next;
}

export function showError(error: unknown) {
  console.error(error);
  notice.value = { text: (error as Error)?.message ?? String(error), kind: "danger" };
}

export function showSuccess(text: string) {
  const shown = { text, kind: "success" as const };
  notice.value = shown;
  // Errors stay until read, good news shouldn't keep taking up room.
  setTimeout(() => {
    if (notice.value === shown) notice.value = null;
  }, 5000);
}

export async function updateSettings(change: Partial<Settings>) {
  const next = mergeSettings({ ...settings.value, ...change });
  settings.value = next;
  await saveSettings(next);
}

export async function refreshActive() {
  const id = settings.value.activeDatasetId;
  coverage.value = id ? await embeddingCoverage(id) : [];
  hasProjection.value = id ? !!(await getProjection(id, activeModelKey.value)) : false;
}

export async function refreshDatasets() {
  const all = await listDatasets();
  datasets.value = all;
  if (!all.some((d) => d.id === settings.value.activeDatasetId)) {
    await updateSettings({ activeDatasetId: all[0]?.id ?? null });
  }
  await refreshActive();
  dataVersion.value++;
}

export async function selectDataset(id: string) {
  await updateSettings({ activeDatasetId: id });
  await refreshActive();
  dataVersion.value++;
}

function upsertJob(job: Job) {
  const others = jobs.value.filter((j) => j.id !== job.id);
  jobs.value = [job, ...others].sort((a, b) => b.startedAt - a.startedAt);
}

export async function initState() {
  window.addEventListener("hashchange", () => (view.value = viewFromHash()));
  matchMedia(NARROW).addEventListener("change", (e) => (narrow.value = e.matches));

  onMessage((message) => {
    switch (message.type) {
      case "jobs":
        jobs.value = [...message.jobs].sort((a: Job, b: Job) => b.startedAt - a.startedAt);
        break;
      case "job": {
        const before = jobs.value.find((j) => j.id === message.job.id);
        upsertJob(message.job);
        if (before?.status === "running" && message.job.status !== "running") {
          refreshDatasets().catch(showError);
        }
        break;
      }
      case "job-removed":
        jobs.value = jobs.value.filter((j) => j.id !== message.jobId);
        break;
      case "datasets-changed":
        refreshDatasets().catch(showError);
        break;
    }
  });
  startConnection();

  settings.value = await loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settingsV2) {
      settings.value = mergeSettings(changes.settingsV2.newValue as Partial<Settings>);
      refreshActive().catch(showError);
    }
  });
  await refreshDatasets();
  loaded.value = true;
}

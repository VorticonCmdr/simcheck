import { applyUpdate, createJob, pruneJobs, throttle, type JobUpdate } from "../core/jobs";
import type {
  ClusterPayload,
  ComparePayload,
  EmbedPayload,
  MergePayload,
  ReclusterPayload,
} from "../core/protocol";
import {
  fromLegacySettings,
  loadOpenAiKey,
  loadSettings,
  mergeSettings,
  saveOpenAiKey,
  saveSettings,
  type LegacySettings,
  type ModelConfig,
} from "../core/settings";
import type { Job, JobKind } from "../core/types";

const WORKSPACE = "index.html";

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(WORKSPACE);
  const [open] = await chrome.runtime.getContexts({ contextTypes: ["TAB" as any] });
  if (open?.tabId !== undefined && open.tabId >= 0 && open.documentUrl?.startsWith(url)) {
    await chrome.tabs.update(open.tabId, { active: true });
    if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// ── offscreen document ───────────────────────────────────────────────────────

let offscreenReady: Promise<void> | null = null;
const offscreenUrl = () => chrome.runtime.getURL("offscreen.html");

const offscreenExists = async () =>
  (
    await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as any],
      documentUrls: [offscreenUrl()],
    })
  ).length > 0;

// Only one offscreen document may exist, so concurrent callers share one attempt.
function ensureOffscreen(): Promise<void> {
  offscreenReady ??= (async () => {
    if (await offscreenExists()) return;
    await chrome.offscreen.createDocument({
      url: offscreenUrl(),
      reasons: ["WORKERS" as any],
      justification: "Model inference and heavy computation over stored embeddings",
    });
  })().finally(() => {
    offscreenReady = null;
  });
  return offscreenReady;
}

const START_TIMEOUT_MS = 30000;

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
  Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);

async function callOffscreen(message: Record<string, unknown>): Promise<any> {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ ...message, target: "offscreen" });
  if (response?.error) throw new Error(response.error);
  return response;
}

// ── jobs ─────────────────────────────────────────────────────────────────────

// Kept in session storage too: the service worker can stop while a job goes on
// in the offscreen document, and has to know about that job when it wakes up.
const jobs = new Map<string, Job>();
const ports = new Set<chrome.runtime.Port>();

const restored = (async () => {
  const { jobs: saved } = await chrome.storage.session.get("jobs");
  for (const job of (saved as Job[] | undefined) ?? []) jobs.set(job.id, job);

  // A saved "running" only says a job was started: this worker can stop before the
  // job reaches the offscreen document. Check with the document, or it would spin forever.
  const running = [...jobs.values()].filter((job) => job.status === "running");
  if (!running.length) return;
  const active = await activeOffscreenJobs();
  if (!active) return; // no answer says nothing about the jobs, so leave them be
  for (const job of running) {
    if (active.includes(job.id)) continue;
    jobs.set(
      job.id,
      applyUpdate(job, { type: "error", error: "interrupted before it finished, please run it again" }, Date.now()),
    );
  }
})();

async function activeOffscreenJobs(): Promise<string[] | null> {
  if (!(await offscreenExists())) return [];
  const response = await withTimeout(
    chrome.runtime.sendMessage({ target: "offscreen", action: "activeJobs" }).catch(() => null),
    3000,
  );
  return response === "timeout" ? null : (response?.jobIds ?? []);
}

function broadcast(message: unknown) {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
}

const persistJobs = throttle<null>(1000, () => {
  const kept = pruneJobs([...jobs.values()]);
  jobs.clear();
  kept.forEach((job) => jobs.set(job.id, job));
  chrome.storage.session.set({ jobs: kept });
});

function publish(job: Job) {
  jobs.set(job.id, job);
  broadcast({ type: "job", job });
  if (job.status === "running") persistJobs(null);
  else {
    persistJobs(null);
    persistJobs.flush();
  }
}

function notifyFinished(job: Job) {
  if (job.status !== "done" || !["embed", "cluster", "compare"].includes(job.kind)) return;
  chrome.notifications.create(job.id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/clusters48.png"),
    title: "simcheck",
    message: `${job.title}: finished`,
  });
}

async function onJobFinished(job: Job) {
  notifyFinished(job);
  if (job.kind === "embed" && job.status === "done") {
    const { msPerRow, modelId } = job.result as { msPerRow: number | null; modelId: string };
    if (msPerRow !== null) {
      const settings = await loadSettings();
      settings.msPerRow[modelId] = msPerRow;
      await saveSettings(settings);
    }
  }
  if (job.kind === "migrate" && job.status === "done") {
    await chrome.storage.local.set({ migrationDone: true });
    broadcast({ type: "datasets-changed" });
  }
  if (job.kind === "merge" && job.status === "done") broadcast({ type: "datasets-changed" });
}

async function updateJob(jobId: string, update: JobUpdate) {
  await restored;
  const job = jobs.get(jobId);
  if (!job) return;
  const next = applyUpdate(job, update, Date.now());
  if (next === job) return;
  publish(next);
  if (next.status !== "running") await onJobFinished(next);
}

async function startJob(kind: JobKind, title: string, datasetId: string | null, payload: unknown) {
  await restored;
  const job = createJob(crypto.randomUUID(), kind, title, datasetId, Date.now());
  publish(job);
  try {
    const started = await withTimeout(
      callOffscreen({ action: "startJob", jobId: job.id, kind, payload }),
      START_TIMEOUT_MS,
    );
    if (started === "timeout") throw new Error("the background page didn't respond");
  } catch (error: any) {
    await updateJob(job.id, { type: "error", error: error.message });
  }
  return job.id;
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

// Runs here so the key doesn't have to travel to any other context.
async function openAiEmbed(texts: string[], model: string): Promise<number[][]> {
  const key = await loadOpenAiKey();
  if (!key) throw new Error("no OpenAI key set: add one under Models");

  for (let attempt = 0; ; attempt++) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model.replace("openai/", ""), input: texts }),
    });
    if (response.status === 429 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(
        `OpenAI request failed (${response.status})${detail?.error?.message ? `: ${detail.error.message}` : ""}`,
      );
    }
    const body = await response.json();
    const vectors: number[][] = [];
    for (const item of body.data) vectors[item.index] = item.embedding;
    return vectors;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.source !== "offscreen") return false;

  if (message.type === "job-update") {
    updateJob(message.jobId, message.update);
    return false;
  }
  if (message.type === "openai-embed") {
    openAiEmbed(message.texts, message.model)
      .then((vectors) => sendResponse({ vectors }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  return false;
});

// ── requests from the workspace ──────────────────────────────────────────────

async function activeModel(): Promise<ModelConfig> {
  return (await loadSettings()).model;
}

async function handleRequest(action: string, p: any): Promise<unknown> {
  switch (action) {
    case "embed": {
      const payload = p as EmbedPayload;
      return startJob("embed", `Embed ${p.datasetName}`, payload.datasetId, payload);
    }
    case "download":
      return startJob("download", `Download ${p.model.id}`, null, { model: p.model });
    case "cluster": {
      const payload = p as ClusterPayload;
      return startJob("cluster", `Cluster ${p.datasetName}`, payload.datasetId, payload);
    }
    case "recluster": {
      const payload = p as ReclusterPayload;
      const action = payload.clustering ? "Re-cluster" : payload.merge ? "Merge clusters in" : "Rename clusters in";
      return startJob("recluster", `${action} ${p.datasetName}`, payload.datasetId, payload);
    }
    case "compare": {
      const payload = p as ComparePayload;
      return startJob("compare", `Compare ${p.title}`, payload.datasetA, payload);
    }
    case "merge": {
      const payload = p as MergePayload;
      return startJob("merge", `Merge into ${payload.name}`, null, payload);
    }
    case "cancelJob": {
      await restored;
      const { cancelled } = await callOffscreen({ action: "cancelJob", jobId: p.jobId });
      // Nothing there to cancel any more: don't leave it spinning forever.
      if (!cancelled) await updateJob(p.jobId, { type: "cancelled" });
      return null;
    }
    case "dismissJob":
      await restored;
      jobs.delete(p.jobId);
      broadcast({ type: "job-removed", jobId: p.jobId });
      persistJobs(null);
      return null;
    case "search":
      return (await callOffscreen({ action: "search", ...p, model: await activeModel() })).hits;
    case "tokens":
      return (await callOffscreen({ action: "tokens", text: p.text, model: await activeModel() })).count;
    case "testOpenAi": {
      const started = performance.now();
      const [vector] = await openAiEmbed(["test"], "openai/text-embedding-3-small");
      return { dims: vector.length, ms: Math.round(performance.now() - started) };
    }
    case "testModel":
      return callOffscreen({ action: "testModel", model: p.model });
    default:
      throw new Error(`unknown action ${action}`);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));

  restored.then(() => {
    try {
      port.postMessage({ type: "jobs", jobs: [...jobs.values()] });
    } catch {
      ports.delete(port);
    }
  });

  port.onMessage.addListener(async ({ id, action, payload }) => {
    try {
      const result = await handleRequest(action, payload);
      port.postMessage({ replyTo: id, result });
    } catch (error: any) {
      console.error(`[background] ${action} failed:`, error);
      try {
        port.postMessage({ replyTo: id, error: error.message });
      } catch {
        // the page went away while we were working
      }
    }
  });
});

// ── migration from the multi-page version ────────────────────────────────────

async function migrate() {
  const { migrationDone, settings: legacy, settingsV2 } = await chrome.storage.local.get([
    "migrationDone",
    "settings",
    "settingsV2",
  ]);
  if (migrationDone) return;
  await restored;
  if ([...jobs.values()].some((job) => job.kind === "migrate" && job.status === "running")) return;
  // Starts over after an interruption, which is safe: dataset ids are deterministic.
  for (const job of jobs.values()) {
    if (job.kind === "migrate") jobs.delete(job.id);
  }

  if (!legacy) {
    await chrome.storage.local.set({ migrationDone: true });
    return;
  }

  const old = legacy as LegacySettings;
  if (!settingsV2) await saveSettings(mergeSettings(fromLegacySettings(old)));
  if (old.openai?.key && !(await loadOpenAiKey())) await saveOpenAiKey(old.openai.key);
  const { pooling } = (await loadSettings()).model;
  await startJob("migrate", "Move data to the new format", null, { pooling });
}

migrate();

import type { Job, JobKind } from "./types";

export function createJob(
  id: string,
  kind: JobKind,
  title: string,
  datasetId: string | null,
  now: number,
): Job {
  return {
    id,
    kind,
    title,
    status: "running",
    phase: "starting",
    progress: null,
    etaSeconds: null,
    error: null,
    result: null,
    startedAt: now,
    phaseStartedAt: now,
    finishedAt: null,
    datasetId,
  };
}

export type JobUpdate =
  | { type: "progress"; phase?: string; progress?: number | null }
  | { type: "done"; result?: unknown }
  | { type: "error"; error: string }
  | { type: "cancelled" };

export function applyUpdate(job: Job, update: JobUpdate, now: number): Job {
  // Late progress from a job that already ended must not bring it back.
  if (job.status !== "running") return job;

  switch (update.type) {
    case "progress": {
      const progress = update.progress === undefined ? job.progress : update.progress;
      const phaseChanged = update.phase !== undefined && update.phase !== job.phase;
      const phaseStartedAt = phaseChanged ? now : job.phaseStartedAt;
      const elapsed = (now - phaseStartedAt) / 1000;
      return {
        ...job,
        phase: update.phase ?? job.phase,
        phaseStartedAt,
        progress,
        etaSeconds:
          progress && progress > 0.01 && !phaseChanged
            ? Math.round((elapsed / progress) * (1 - progress))
            : null,
      };
    }
    case "done":
      return {
        ...job,
        status: "done",
        phase: "done",
        progress: 1,
        etaSeconds: null,
        result: update.result ?? null,
        finishedAt: now,
      };
    case "error":
      return {
        ...job,
        status: "error",
        etaSeconds: null,
        error: update.error,
        finishedAt: now,
      };
    case "cancelled":
      return { ...job, status: "cancelled", etaSeconds: null, finishedAt: now };
  }
}

/** Calls at most once per interval, and always delivers the latest value. */
export function throttle<T>(interval: number, deliver: (value: T) => void) {
  let last = 0;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending) {
      const { value } = pending;
      pending = null;
      last = Date.now();
      deliver(value);
    }
  };

  const call = (value: T) => {
    pending = { value };
    const wait = interval - (Date.now() - last);
    if (wait <= 0) flush();
    else timer ??= setTimeout(flush, wait);
  };
  call.flush = flush;
  return call;
}

/** Keeps running jobs plus the most recently finished ones. */
export function pruneJobs(jobs: Job[], keepFinished = 20): Job[] {
  const finished = jobs
    .filter((job) => job.status !== "running")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, keepFinished);
  const keep = new Set(finished);
  return jobs.filter((job) => job.status === "running" || keep.has(job));
}

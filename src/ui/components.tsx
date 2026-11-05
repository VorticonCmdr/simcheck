import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Job } from "../core/types";
import { call } from "./api";
import { jobs, notice, runningJobs, showError } from "./state";
import { formatDuration } from "./util";

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ComponentChildren;
}) {
  return (
    <div class="empty-state">
      <h2 class="h5">{title}</h2>
      {children}
    </div>
  );
}

/** Native dialog: focus trapping, Escape and restoring focus all come with it. */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} class="app-dialog" aria-label={title}>
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h2 class="h5 mb-0">{title}</h2>
        <button type="button" class="btn-close" aria-label="Close" onClick={onClose} />
      </div>
      {open && children}
    </dialog>
  );
}

export function Progress({ value, label }: { value: number | null; label: string }) {
  const percent = value === null ? 100 : Math.round(value * 100);
  return (
    <div
      class="progress"
      role="progressbar"
      aria-label={label}
      aria-valuenow={value === null ? undefined : percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        class={`progress-bar ${value === null ? "progress-bar-striped progress-bar-animated" : ""}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  const running = job.status === "running";
  const detail = running
    ? [
        job.phase,
        job.progress !== null ? `${Math.round(job.progress * 100)}%` : null,
        job.etaSeconds !== null ? `${formatDuration(job.etaSeconds)} left` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : job.status === "error"
      ? job.error
      : job.status;

  return (
    <li class="job-row" data-status={job.status}>
      <div class="d-flex justify-content-between gap-2">
        <strong class="text-truncate">{job.title}</strong>
        {running ? (
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary py-0"
            onClick={() => call("cancelJob", { jobId: job.id }).catch(showError)}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            class="btn-close btn-sm"
            aria-label={`Dismiss ${job.title}`}
            onClick={() => call("dismissJob", { jobId: job.id }).catch(showError)}
          />
        )}
      </div>
      <div class={`small ${job.status === "error" ? "text-danger" : "text-body-secondary"}`}>
        {detail}
      </div>
      {running && <Progress value={job.progress} label={job.title} />}
    </li>
  );
}

export function JobTray() {
  const running = runningJobs.value;
  const failed = jobs.value.filter((job) => job.status === "error").length;
  const lead = running[0];
  const summary = lead
    ? `${running.length > 1 ? `${running.length} jobs` : lead.title}${
        lead.progress !== null ? ` ${Math.round(lead.progress * 100)}%` : ""
      }`
    : failed
      ? `${failed} failed`
      : "Jobs";

  return (
    <details class="job-tray">
      <summary class="btn btn-sm btn-outline-secondary" aria-live="polite">
        {lead && <span class="spinner-border spinner-border-sm me-1" aria-hidden="true" />}
        <span class="job-summary">{summary}</span>
      </summary>
      <div class="job-panel">
        {jobs.value.length ? (
          <ul class="list-unstyled mb-0">
            {jobs.value.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        ) : (
          <p class="small text-body-secondary mb-0">Nothing has run yet.</p>
        )}
      </div>
    </details>
  );
}

export function Notice() {
  const current = notice.value;
  if (!current) return null;
  return (
    <div class={`alert alert-${current.kind} alert-dismissible m-3 mb-0`} role="alert">
      {current.text}
      <button
        type="button"
        class="btn-close"
        aria-label="Dismiss"
        onClick={() => (notice.value = null)}
      />
    </div>
  );
}

/** Bars with a value per mark, so the numbers are readable without hovering. */
export function Bars({
  items,
  unit = "",
}: {
  items: { label: string; value: number; title?: string }[];
  unit?: string;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <ul class="bars list-unstyled mb-0">
      {items.map((item) => (
        <li key={item.label} title={item.title ?? `${item.label}: ${item.value}${unit}`}>
          <span class="bar-label text-truncate">{item.label}</span>
          <span class="bar-track">
            <span class="bar-fill" style={{ width: `${(item.value / max) * 100}%` }} />
          </span>
          <span class="bar-value">{item.value.toLocaleString()}{unit}</span>
        </li>
      ))}
    </ul>
  );
}

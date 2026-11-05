import { useEffect, useRef, useState } from "preact/hooks";
import { rowText } from "../core/csv";
import { looksNonEnglish } from "../core/language";
import { DEFAULT_MODEL, MULTILINGUAL_MODEL, isOpenAi } from "../core/settings";
import type { Dataset, Row } from "../core/types";
import { call } from "./api";
import { activeCoverage, activeModelKey, refreshActive, settings, showError, updateSettings } from "./state";
import { formatDuration } from "./util";

/** Picks and orders the columns to embed: by dragging, or by keyboard with the arrows. */
export function FieldPicker({
  columns,
  selected,
  onChange,
}: {
  columns: string[];
  selected: string[];
  onChange: (fields: string[]) => void;
}) {
  const dragged = useRef<number | null>(null);
  const move = (from: number, to: number) => {
    const next = [...selected];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
  };
  const available = columns.filter((column) => !selected.includes(column));

  return (
    <div>
      <div class="d-flex flex-wrap gap-1 mb-2" aria-label="Fields to embed, in order">
        {selected.length === 0 && (
          <span class="text-body-secondary small">No fields selected yet.</span>
        )}
        {selected.map((field, index) => (
          <span
            key={field}
            class="chip"
            draggable
            onDragStart={() => (dragged.current = index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => dragged.current !== null && move(dragged.current, index)}
          >
            {field}
            <button type="button" aria-label={`Move ${field} earlier`} disabled={index === 0} onClick={() => move(index, index - 1)}>‹</button>
            <button type="button" aria-label={`Move ${field} later`} disabled={index === selected.length - 1} onClick={() => move(index, index + 1)}>›</button>
            <button type="button" aria-label={`Remove ${field}`} onClick={() => onChange(selected.filter((f) => f !== field))}>×</button>
          </span>
        ))}
      </div>
      {available.length > 0 && (
        <select
          class="form-select form-select-sm w-auto"
          aria-label="Add a field"
          value=""
          data-testid="add-field"
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value) onChange([...selected, value]);
          }}
        >
          <option value="">Add a field…</option>
          {available.map((column) => (
            <option key={column} value={column}>{column}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function useTokenCount(text: string) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    setCount(null);
    if (!text) return;
    const timer = setTimeout(() => {
      call<number>("tokens", { text }).then(setCount).catch(() => setCount(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [text, settings.value.model.id]);
  return count;
}

export function ExamplePreview({ row, fields }: { row: Row | undefined; fields: string[] }) {
  const text = row ? rowText(row, fields) : "";
  const tokens = useTokenCount(text);
  return (
    <div class="mt-3">
      <div class="small text-body-secondary mb-1">
        Text of the first row{tokens !== null ? ` · ${tokens} tokens` : ""}
      </div>
      <div class="border rounded p-2 small" data-testid="example-text">
        {text || <span class="text-body-secondary">Pick a field to see the text that gets embedded.</span>}
      </div>
    </div>
  );
}

/** What embedding will do and cost, plus the button that starts it. */
export function EmbedAction({
  dataset,
  rowCount,
  fields,
  beforeStart,
  onStarted,
  sampleText = "",
  samples = [],
}: {
  dataset: Dataset | null;
  rowCount: number;
  fields: string[];
  /** Runs first, and returns the dataset to embed. */
  beforeStart?: () => Promise<Dataset | null>;
  onStarted?: () => void;
  /** One row's text, for estimating what a paid model will use. */
  sampleText?: string;
  /** Texts of some rows, to notice data the active model doesn't suit. */
  samples?: string[];
}) {
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const { model, msPerRow } = settings.value;
  const existing = dataset ? activeCoverage.value : 0;
  const measured = msPerRow[model.id];

  const estimate = isOpenAi(model.id)
    ? `runs on OpenAI and is billed to your key${
        sampleText ? `, roughly ${Math.ceil((sampleText.length / 4) * rowCount).toLocaleString()} tokens going by the first row` : ""
      }`
    : measured
      ? `about ${formatDuration((rowCount * measured) / 1000)} at the last measured speed`
      : "runs in this browser";

  const wrongLanguage = model.id === DEFAULT_MODEL && looksNonEnglish(samples);
  const useMultilingual = () => {
    const { id, pooling, dtype } = MULTILINGUAL_MODEL;
    updateSettings({ model: { ...model, id, pooling, dtype } }).then(refreshActive).catch(showError);
  };

  const start = async () => {
    setBusy(true);
    try {
      const target = beforeStart ? await beforeStart() : dataset;
      if (!target) return;
      await call("embed", {
        datasetId: target.id,
        datasetName: target.name,
        fields,
        model,
        modelKey: activeModelKey.value,
        force,
      });
      onStarted?.();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p class="small text-body-secondary mb-2">
        {rowCount.toLocaleString()} rows with {model.id}: {estimate}.
      </p>
      {wrongLanguage && (
        <div class="alert alert-info py-2 small" data-testid="language-hint">
          <p class="mb-2">
            This text doesn't look English, which is what {DEFAULT_MODEL.split("/").pop()} is
            made for. A multilingual model should cluster it much better.
          </p>
          <button type="button" class="btn btn-sm btn-outline-primary" data-testid="use-multilingual" onClick={useMultilingual}>
            Use the multilingual model ({MULTILINGUAL_MODEL.downloadMb} MB download)
          </button>
        </div>
      )}
      {existing > 0 && (
        <div class="form-check mb-2">
          <input class="form-check-input" type="checkbox" id="force-embed" checked={force} onChange={(e) => setForce(e.currentTarget.checked)} />
          <label class="form-check-label" for="force-embed">
            Re-embed all rows. Otherwise the {existing.toLocaleString()} rows already embedded are
            skipped, unless their text changed.
          </label>
        </div>
      )}
      <button type="button" class="btn btn-primary" data-testid="embed" disabled={busy || fields.length === 0} onClick={start}>
        {busy ? "Starting…" : `Embed with ${model.id.split("/").pop()}`}
      </button>
    </div>
  );
}

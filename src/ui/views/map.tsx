import Flatbush from "flatbush";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { toCsv } from "../../core/csv";
import { getEmbedding, getProjection } from "../../core/db";
import { NOISE } from "../../core/dbscan";
import { pointInPolygon } from "../../core/geometry";
import { SERIES_LIMIT, noiseColor, otherColor, seriesColor } from "../../core/palette";
import type { Projection, Row } from "../../core/types";
import { cosine } from "../../core/vector";
import { EmptyState } from "../components";
import { activeDataset, activeModelKey, dataVersion, go, showError } from "../state";
import { allRows, clusterName, isDark, saveFile } from "../util";

type SelectMode = "box" | "lasso";

interface Transform { k: number; x: number; y: number }

interface Rule { id: number; field: string; pattern: string; regex: RegExp; color: string }

const DOT_SIZE_KEY = "mapDotSize";
const DOT_SIZE = { min: 0.5, max: 10, step: 0.5, initial: 6 };

function storedDotSize() {
  try {
    const stored = Number(localStorage.getItem(DOT_SIZE_KEY));
    return stored >= DOT_SIZE.min && stored <= DOT_SIZE.max ? stored : DOT_SIZE.initial;
  } catch {
    return DOT_SIZE.initial;
  }
}

function saveDotSize(size: number) {
  try {
    localStorage.setItem(DOT_SIZE_KEY, String(size));
  } catch {
    // The preference just won't survive a reload.
  }
}


function compileRule(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function MapView() {
  const dataset = activeDataset.value;
  const modelKey = activeModelKey.value;
  const [projection, setProjection] = useState<Projection | null | undefined>(undefined);
  const [rows, setRows] = useState<Map<string, Row>>(new Map());
  const [titleField, setTitleField] = useState("");
  const [cluster, setCluster] = useState<number | null>(null);
  const [selection, setSelection] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [rules, setRules] = useState<Rule[]>([]);
  const [ruleField, setRuleField] = useState("");
  const [rulePattern, setRulePattern] = useState("");
  const [ruleColor, setRuleColor] = useState("#e34948");
  const [selectMode, setSelectMode] = useState<SelectMode | null>(null);
  const [colorField, setColorField] = useState("");
  const [dotSize, setDotSize] = useState(storedDotSize);
  const [pairScore, setPairScore] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string; sub: string } | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const transform = useRef<Transform>({ k: 1, x: 0, y: 0 });
  const size = useRef({ width: 0, height: 0 });
  const frame = useRef(0);
  const box = useRef<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  const lasso = useRef<null | [number, number][]>(null);
  const draw = useRef<() => void>(() => {});
  const fit = useRef<() => void>(() => {});

  useEffect(() => {
    if (!dataset) return;
    let current = true;
    setCluster(null);
    setSelection([]);
    setRules([]);
    setColorField("");
    setSearch("");
    Promise.all([getProjection(dataset.id, modelKey), allRows(dataset.id)])
      .then(([stored, data]) => {
        if (!current) return;
        setProjection(stored ?? null);
        setRows(data);
        setTitleField(dataset.textFields[0] ?? dataset.columns[0] ?? "");
        setRuleField(dataset.columns[0] ?? "");
      })
      .catch(showError);
    return () => { current = false; };
  }, [dataset?.id, modelKey, dataVersion.value]);

  const n = projection?.keys.length ?? 0;
  const rowOf = (i: number) => rows.get(projection!.keys[i]) ?? {};
  const titleOf = (i: number) => String(rowOf(i)[titleField] ?? projection!.keys[i]);

  // Unit-square coordinates, so the view transform doesn't depend on the data's scale.
  const points = useMemo(() => {
    if (!projection) return null;
    const { coords } = projection;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, coords[2 * i]);
      maxX = Math.max(maxX, coords[2 * i]);
      minY = Math.min(minY, coords[2 * i + 1]);
      maxY = Math.max(maxY, coords[2 * i + 1]);
    }
    const scale = 1 / Math.max(maxX - minX, maxY - minY, 1e-9);
    const scaled = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) {
      scaled[2 * i] = (coords[2 * i] - minX) * scale;
      scaled[2 * i + 1] = (coords[2 * i + 1] - minY) * scale;
    }
    const index = new Flatbush(Math.max(n, 1));
    for (let i = 0; i < n; i++) index.add(scaled[2 * i], scaled[2 * i + 1]);
    if (n === 0) index.add(0, 0);
    index.finish();
    return { scaled, index };
  }, [projection]);

  const matches = useMemo(() => {
    const text = search.trim().toLowerCase();
    if (!text || !projection) return null;
    const found = new Set<number>();
    for (let i = 0; i < n; i++) {
      if (Object.values(rowOf(i)).some((value) => String(value).toLowerCase().includes(text))) {
        found.add(i);
      }
    }
    return found;
  }, [search, projection, rows]);

  const ruleColors = useMemo(() => {
    if (!rules.length || !projection) return null;
    const colors = new Map<number, string>();
    for (let i = 0; i < n; i++) {
      const row = rowOf(i);
      const rule = rules.find((r) => r.regex.test(String(row[r.field] ?? "")));
      if (rule) colors.set(i, rule.color);
    }
    return colors;
  }, [rules, projection, rows]);

  // The most common values get palette slots, as clusters do; the rest are "other".
  const categories = useMemo(() => {
    if (!colorField || !projection) return null;
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const value = String(rowOf(i)[colorField] ?? "");
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, SERIES_LIMIT);
    const slots = new Map(top.map(([value], slot) => [value, slot]));
    const slotOf = new Int8Array(n);
    for (let i = 0; i < n; i++) slotOf[i] = slots.get(String(rowOf(i)[colorField] ?? "")) ?? -1;
    return { top, slotOf };
  }, [colorField, projection, rows]);

  const selectedSet = useMemo(() => new Set(selection), [selection]);

  useEffect(() => {
    setPairScore(null);
    if (selection.length !== 2 || !projection || !dataset) return;
    let current = true;
    Promise.all(selection.map((i) => getEmbedding(dataset.id, modelKey, projection.keys[i])))
      .then(([a, b]) => { if (current && a && b) setPairScore(cosine(a, b)); })
      .catch(showError);
    return () => { current = false; };
  }, [selection]);

  draw.current = () => {
    const element = canvas.current;
    if (!element || !projection || !points) return;
    const context = element.getContext("2d")!;
    const { width, height } = size.current;
    const ratio = devicePixelRatio;
    const dark = isDark();
    const { k, x, y } = transform.current;
    const { scaled } = points;
    const { labels } = projection;

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const spotlight = cluster !== null || matches !== null || selectedSet.size > 0;
    const radius = dotSize;
    const colorOf = (i: number) => {
      const fromRule = ruleColors?.get(i);
      if (fromRule) return fromRule;
      if (categories) {
        const slot = categories.slotOf[i];
        return slot >= 0 ? seriesColor(slot, dark) : otherColor(dark);
      }
      const label = labels[i];
      if (label === NOISE) return noiseColor(dark);
      return label < SERIES_LIMIT ? seriesColor(label, dark) : otherColor(dark);
    };
    const lit = (i: number) =>
      (cluster === null || labels[i] === cluster) &&
      (matches === null || matches.has(i)) &&
      (selectedSet.size === 0 || selectedSet.has(i));

    // Batched by colour: changing fillStyle per point dominates at this scale.
    const batches = new Map<string, number[]>();
    const add = (color: string, i: number) => {
      const batch = batches.get(color);
      if (batch) batch.push(i);
      else batches.set(color, [i]);
    };
    const faded: number[] = [];
    for (let i = 0; i < n; i++) {
      const px = scaled[2 * i] * k + x;
      const py = scaled[2 * i + 1] * k + y;
      if (px < -radius || py < -radius || px > width + radius || py > height + radius) continue;
      if (spotlight && !lit(i)) faded.push(i);
      else add(colorOf(i), i);
    }

    context.globalAlpha = 0.12;
    context.fillStyle = noiseColor(dark);
    context.beginPath();
    for (const i of faded) {
      const px = scaled[2 * i] * k + x;
      const py = scaled[2 * i + 1] * k + y;
      context.moveTo(px + radius, py);
      context.arc(px, py, radius, 0, Math.PI * 2);
    }
    context.fill();

    context.globalAlpha = 0.85;
    for (const [color, batch] of batches) {
      context.fillStyle = color;
      context.beginPath();
      for (const i of batch) {
        const px = scaled[2 * i] * k + x;
        const py = scaled[2 * i + 1] * k + y;
        context.moveTo(px + radius, py);
        context.arc(px, py, radius, 0, Math.PI * 2);
      }
      context.fill();
    }
    context.globalAlpha = 1;

    // Labels from the largest cluster down, skipping any that would overlap.
    context.font = "12px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    const body = getComputedStyle(element);
    const ink = body.getPropertyValue("--bs-body-color");
    const halo = body.getPropertyValue("--bs-tertiary-bg");
    const placed: [number, number, number, number][] = [];
    const keyIndex = keyLookup.current;
    for (const summary of projection.clusters) {
      if (cluster !== null && summary.id !== cluster) continue;
      const i = keyIndex.get(summary.representativeKey);
      if (i === undefined) continue;
      const px = scaled[2 * i] * k + x;
      const py = scaled[2 * i + 1] * k + y - radius - 10; // above the point, not on it
      if (px < 0 || py < 0 || px > width || py > height) continue;
      const text = clusterName(summary);
      const half = context.measureText(text).width / 2 + 4;
      const rect: [number, number, number, number] = [px - half, py - 10, px + half, py + 10];
      if (placed.some((p) => rect[0] < p[2] && rect[2] > p[0] && rect[1] < p[3] && rect[3] > p[1])) continue;
      placed.push(rect);
      context.lineWidth = 3;
      context.strokeStyle = halo;
      context.strokeText(text, px, py);
      context.fillStyle = ink;
      context.fillText(text, px, py);
    }

    if (lasso.current) {
      context.strokeStyle = ink;
      context.setLineDash([4, 3]);
      context.lineWidth = 1;
      context.beginPath();
      lasso.current.forEach(([px, py], i) => (i ? context.lineTo(px, py) : context.moveTo(px, py)));
      context.closePath();
      context.stroke();
      context.setLineDash([]);
    }

    if (box.current) {
      const { x0, y0, x1, y1 } = box.current;
      context.strokeStyle = ink;
      context.setLineDash([4, 3]);
      context.lineWidth = 1;
      context.strokeRect(x0, y0, x1 - x0, y1 - y0);
      context.setLineDash([]);
    }
  };

  const keyLookup = useRef(new Map<string, number>());
  useEffect(() => {
    keyLookup.current = new Map(projection?.keys.map((key, i) => [key, i]) ?? []);
  }, [projection]);

  const requestDraw = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      draw.current();
    });
  };

  const fitted = ({ width, height }: { width: number; height: number }) => {
    const margin = 48;
    const k = Math.max(10, Math.min(width, height) - 2 * margin);
    return { k, x: (width - k) / 2, y: (height - k) / 2 };
  };

  fit.current = () => {
    transform.current = fitted(size.current);
    requestDraw();
  };

  const framedFor = useRef<Projection | null>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      const before = size.current;
      const was = fitted(before);
      const { k, x, y } = transform.current;
      const untouched = k === was.k && x === was.x && y === was.y;
      size.current = { width, height };
      element.width = Math.round(width * devicePixelRatio);
      element.height = Math.round(height * devicePixelRatio);
      if (framedFor.current !== projection && width > 0) {
        framedFor.current = projection ?? null;
        fit.current();
      } else if (untouched) {
        fit.current();
      } else {
        // Keep the user's zoom, and what they were looking at in the middle.
        transform.current = { k, x: x + (width - before.width) / 2, y: y + (height - before.height) / 2 };
        requestDraw();
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [projection]);

  useEffect(requestDraw, [cluster, selection, matches, ruleColors, categories, titleField, points, dotSize]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const zoomAt = (px: number, py: number, factor: number) => {
    const { k, x, y } = transform.current;
    const next = Math.min(Math.max(k * factor, 40), 200000);
    const applied = next / k;
    transform.current = { k: next, x: px - (px - x) * applied, y: py - (py - y) * applied };
    requestDraw();
  };

  const nearest = (px: number, py: number): number | null => {
    if (!points) return null;
    const { k, x, y } = transform.current;
    const [i] = points.index.neighbors((px - x) / k, (py - y) / k, 1, 10 / k);
    return i ?? null;
  };

  const pointer = useRef<null | { x: number; y: number; moved: boolean; mode: SelectMode | null }>(null);
  const local = (event: PointerEvent | WheelEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  const onPointerDown = (event: PointerEvent) => {
    const [x, y] = local(event);
    canvas.current!.setPointerCapture(event.pointerId);
    const mode = selectMode ?? (event.shiftKey ? "box" : null);
    pointer.current = { x, y, moved: false, mode };
    if (mode === "lasso") lasso.current = [[x, y]];
    setTooltip(null);
  };
  const onPointerMove = (event: PointerEvent) => {
    const [x, y] = local(event);
    const held = pointer.current;
    if (held) {
      if (Math.hypot(x - held.x, y - held.y) > 3) held.moved = true;
      if (held.mode === "box") {
        box.current = { x0: Math.min(held.x, x), y0: Math.min(held.y, y), x1: Math.max(held.x, x), y1: Math.max(held.y, y) };
      } else if (held.mode === "lasso") {
        lasso.current!.push([x, y]);
      } else {
        transform.current.x += x - held.x;
        transform.current.y += y - held.y;
        held.x = x;
        held.y = y;
      }
      requestDraw();
      return;
    }
    const i = nearest(x, y);
    setTooltip(
      i === null
        ? null
        : {
            x,
            y,
            text: titleOf(i),
            sub: projection!.labels[i] === NOISE ? "unclustered" : clusterName(projection!.clusters[projection!.labels[i]]),
          },
    );
  };
  const onPointerUp = (event: PointerEvent) => {
    const held = pointer.current;
    pointer.current = null;
    if (!held) return;
    if (held.mode && points) {
      const { k, x, y } = transform.current;
      const path = lasso.current;
      if (box.current) {
        const { x0, y0, x1, y1 } = box.current;
        setSelection(Array.from(points.index.search((x0 - x) / k, (y0 - y) / k, (x1 - x) / k, (y1 - y) / k)));
      } else if (path && path.length > 2) {
        const xs = path.map(([px]) => px);
        const ys = path.map(([, py]) => py);
        const candidates = points.index.search(
          (Math.min(...xs) - x) / k,
          (Math.min(...ys) - y) / k,
          (Math.max(...xs) - x) / k,
          (Math.max(...ys) - y) / k,
        );
        const { scaled } = points;
        setSelection(
          Array.from(candidates).filter((i) =>
            pointInPolygon(scaled[2 * i] * k + x, scaled[2 * i + 1] * k + y, path),
          ),
        );
      }
      setCluster(null);
      setSelectMode(null);
      box.current = null;
      lasso.current = null;
      requestDraw();
      return;
    }
    if (!held.moved) {
      const [x, y] = local(event);
      const i = nearest(x, y);
      const label = i === null ? null : projection!.labels[i];
      setCluster(label === null || label === NOISE ? null : label);
      setSelection([]);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const { width, height } = size.current;
    const step = 40;
    switch (event.key) {
      case "Escape": setCluster(null); setSelection([]); setSelectMode(null); fit.current(); break;
      case "+": case "=": zoomAt(width / 2, height / 2, 1.4); break;
      case "-": zoomAt(width / 2, height / 2, 1 / 1.4); break;
      case "ArrowLeft": transform.current.x += step; requestDraw(); break;
      case "ArrowRight": transform.current.x -= step; requestDraw(); break;
      case "ArrowUp": transform.current.y += step; requestDraw(); break;
      case "ArrowDown": transform.current.y -= step; requestDraw(); break;
      default: return;
    }
    event.preventDefault();
  };

  // Wheel has to be non-passive to stop the page from scrolling too.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const [x, y] = local(event);
      zoomAt(x, y, Math.exp(-event.deltaY * 0.002));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [projection]);

  if (!dataset) {
    return <div class="main-page"><EmptyState title="Nothing to map yet"><button type="button" class="btn btn-primary" onClick={() => go("import")}>Import data</button></EmptyState></div>;
  }
  if (projection === undefined) return <p class="p-4">Loading map…</p>;
  if (projection === null) {
    return (
      <div class="main-page">
        <EmptyState title={`${dataset.name} hasn't been clustered with this model`}>
          <p>The map shows the result of clustering.</p>
          <button type="button" class="btn btn-primary" onClick={() => go("cluster")}>Go to Cluster</button>
        </EmptyState>
      </div>
    );
  }

  const legend = projection.clusters.slice(0, SERIES_LIMIT);
  const others = projection.clusters.length - legend.length;
  const dark = isDark();

  const members = cluster !== null
    ? Array.from(projection.labels.keys()).filter((i) => projection.labels[i] === cluster)
    : selection;
  const panelOpen = cluster !== null || selection.length > 0;
  const summary = cluster !== null ? projection.clusters[cluster] : null;

  const exportMembers = () => {
    const data = members.map((i) => rowOf(i));
    saveFile(`${dataset.name}-selection.csv`, "text/csv", toCsv(data, dataset.columns));
  };
  const addRule = (event: Event) => {
    event.preventDefault();
    const regex = compileRule(rulePattern);
    if (!regex) {
      showError(new Error(`"${rulePattern}" isn't a valid pattern`));
      return;
    }
    setRules([...rules, { id: Date.now(), field: ruleField, pattern: rulePattern, regex, color: ruleColor }]);
    setRulePattern("");
  };

  return (
    <>
      <canvas
        ref={canvas}
        class="map-canvas"
        data-testid="map-canvas"
        tabIndex={0}
        role="application"
        aria-label={`Map of ${n} rows in ${projection.clusters.length} clusters. Arrow keys pan, plus and minus zoom, Escape resets. The legend and panels list the same content.`}
        style={{ cursor: selectMode ? "crosshair" : "grab", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setTooltip(null)}
        onKeyDown={onKeyDown}
      />
      {tooltip && (
        <div class="map-tooltip" style={{ left: `${tooltip.x + 12}px`, top: `${tooltip.y + 12}px` }}>
          <div class="text-truncate">{tooltip.text}</div>
          <div class="text-body-secondary">{tooltip.sub}</div>
        </div>
      )}

      <div class="map-controls">
        <div class="panel">
          <label class="visually-hidden" for="map-search">Highlight rows containing</label>
          <input id="map-search" class="form-control form-control-sm mb-2" type="search" placeholder="Highlight rows containing…" value={search} onInput={(e) => setSearch(e.currentTarget.value)} />
          {matches && <div class="small text-body-secondary mb-2">{matches.size.toLocaleString()} matches</div>}

          <ul class="legend mb-2" aria-label="Clusters">
            {legend.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => { setCluster(cluster === item.id ? null : item.id); setSelection([]); }}>
                  <span class="swatch" style={{ background: seriesColor(item.id, dark) }} />
                  <span class="text-truncate flex-grow-1">{clusterName(item)}</span>
                  <span class="text-body-secondary">{item.size.toLocaleString()}</span>
                </button>
              </li>
            ))}
            {others > 0 && <li class="small d-flex gap-2 align-items-center px-1"><span class="swatch" style={{ background: otherColor(dark) }} />{others} smaller clusters</li>}
            <li class="small d-flex gap-2 align-items-center px-1"><span class="swatch" style={{ background: noiseColor(dark) }} />unclustered ({projection.noise.toLocaleString()})</li>
          </ul>

          {categories && (
            <ul class="legend mb-2" aria-label={`Values of ${colorField}`}>
              {categories.top.map(([value, count], slot) => (
                <li key={value} class="d-flex gap-2 align-items-center px-1">
                  <span class="swatch" style={{ background: seriesColor(slot, dark) }} />
                  <span class="text-truncate flex-grow-1">{value || "(empty)"}</span>
                  <span class="text-body-secondary">{count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}

          <div class="d-flex flex-wrap gap-1 mb-2">
            <button type="button" class={`btn btn-sm ${selectMode === "box" ? "btn-primary" : "btn-outline-secondary"}`} aria-pressed={selectMode === "box"} data-testid="box-select" onClick={() => setSelectMode(selectMode === "box" ? null : "box")} title="Or hold Shift while dragging">Box</button>
            <button type="button" class={`btn btn-sm ${selectMode === "lasso" ? "btn-primary" : "btn-outline-secondary"}`} aria-pressed={selectMode === "lasso"} data-testid="lasso-select" onClick={() => setSelectMode(selectMode === "lasso" ? null : "lasso")}>Lasso</button>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-testid="reset-view" onClick={() => { setCluster(null); setSelection([]); fit.current(); }}>Reset view</button>
          </div>

          <details>
            <summary class="small">Display</summary>
            <label class="form-label small mt-2 mb-0 d-flex justify-content-between" for="dot-size">
              <span>Dot size</span><span class="text-body-secondary">{dotSize}</span>
            </label>
            <input
              id="dot-size"
              type="range"
              class="form-range mb-1"
              min={DOT_SIZE.min}
              max={DOT_SIZE.max}
              step={DOT_SIZE.step}
              value={dotSize}
              onInput={(e) => {
                const size = Number(e.currentTarget.value);
                setDotSize(size);
                saveDotSize(size);
              }}
            />
            <label class="form-label small mb-1" for="title-field">Hover label</label>
            <select id="title-field" class="form-select form-select-sm mb-2" value={titleField} onChange={(e) => setTitleField(e.currentTarget.value)}>
              {dataset.columns.map((column) => <option key={column} value={column}>{column}</option>)}
            </select>
            <label class="form-label small mb-1" for="color-field">Colour by</label>
            <select id="color-field" class="form-select form-select-sm mb-2" value={colorField} onChange={(e) => setColorField(e.currentTarget.value)}>
              <option value="">Cluster</option>
              {dataset.columns.map((column) => <option key={column} value={column}>{column}</option>)}
            </select>
            <form onSubmit={addRule}>
              <label class="form-label small mb-1" for="rule-pattern">Colour rows matching</label>
              <input id="rule-pattern" class="form-control form-control-sm mb-1" placeholder="pattern" value={rulePattern} onInput={(e) => setRulePattern(e.currentTarget.value)} />
              <div class="d-flex gap-1">
                <select class="form-select form-select-sm" aria-label="Field" value={ruleField} onChange={(e) => setRuleField(e.currentTarget.value)}>
                  {dataset.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                </select>
                <input class="form-control form-control-sm form-control-color" type="color" aria-label="Colour" value={ruleColor} onInput={(e) => setRuleColor(e.currentTarget.value)} />
                <button class="btn btn-sm btn-outline-primary" disabled={!rulePattern}>Add</button>
              </div>
            </form>
            <ul class="legend mt-2">
              {rules.map((rule) => (
                <li key={rule.id}>
                  <button type="button" aria-label={`Remove rule ${rule.pattern}`} onClick={() => setRules(rules.filter((r) => r.id !== rule.id))}>
                    <span class="swatch" style={{ background: rule.color }} />
                    <span class="text-truncate flex-grow-1">{rule.field}: {rule.pattern}</span>×
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>

      {panelOpen && (
        <aside class="map-side" aria-label="Selection">
          <div class="panel" data-testid="map-panel">
            <div class="d-flex justify-content-between align-items-start gap-2">
              <h2 class="h6 mb-1">{summary ? clusterName(summary) : `${members.length.toLocaleString()} rows selected`}</h2>
              <button type="button" class="btn-close" aria-label="Close" onClick={() => { setCluster(null); setSelection([]); }} />
            </div>
            {summary && <p class="small text-body-secondary mb-2">{summary.size.toLocaleString()} rows</p>}
            {pairScore !== null && <p class="small mb-2" data-testid="pair-score">Similarity of these 2 rows: <strong>{pairScore.toFixed(3)}</strong></p>}
            <button type="button" class="btn btn-sm btn-outline-secondary mb-2" onClick={exportMembers}>Export CSV</button>
            <ul class="list-unstyled small mb-0">
              {members.slice(0, 200).map((i) => (
                <li key={i} class="border-bottom py-1 text-break">{titleOf(i)}</li>
              ))}
            </ul>
            {members.length > 200 && <p class="small text-body-secondary mt-2 mb-0">Showing the first 200.</p>}
          </div>
        </aside>
      )}
    </>
  );
}

import { useEffect, useState } from "preact/hooks";
import { loadOpenAiKey, modelKey, recommendedPooling, saveOpenAiKey, type Device, type Dtype, type ModelConfig, type Pooling } from "../../core/settings";
import { call } from "../api";
import { jobs, settings, showError, showSuccess, updateSettings, refreshActive, coverage, activeDataset } from "../state";
import { describeModelKey } from "../../core/settings";
import { formatBytes } from "../util";

const CACHE = "transformers-cache";
const OPENAI_MODELS = ["openai/text-embedding-3-small", "openai/text-embedding-3-large"];

interface CachedModel {
  id: string;
  size: number;
  dtypes: string[];
}

const DTYPE_FILES: Record<string, Dtype> = {
  "model.onnx": "fp32",
  "model_fp16.onnx": "fp16",
  "model_quantized.onnx": "q8",
  "model_q8.onnx": "q8",
  "model_q4.onnx": "q4",
  "model_q4f16.onnx": "q4f16",
};

async function listCached(): Promise<CachedModel[]> {
  const cache = await caches.open(CACHE);
  const models = new Map<string, CachedModel>();
  for (const request of await cache.keys()) {
    const match = request.url.match(/huggingface\.co\/([^/]+\/[^/]+)\//);
    if (!match) continue;
    const model = models.get(match[1]) ?? { id: match[1], size: 0, dtypes: [] };
    const dtype = DTYPE_FILES[request.url.split("/").pop() ?? ""];
    if (dtype && !model.dtypes.includes(dtype)) model.dtypes.push(dtype);
    // The header is enough: reading every body would load whole models into memory.
    const response = await cache.match(request);
    model.size += Number(response?.headers.get("content-length") ?? 0);
    models.set(match[1], model);
  }
  return [...models.values()];
}

async function deleteCached(id: string) {
  const cache = await caches.open(CACHE);
  for (const request of await cache.keys()) {
    if (request.url.includes(`huggingface.co/${id}/`)) await cache.delete(request);
  }
}

/** Which dtypes a Hugging Face repo offers, or an explanation of why it can't be used. */
async function inspectRepo(id: string): Promise<Dtype[]> {
  const response = await fetch(`https://huggingface.co/api/models/${id}`);
  if (response.status === 404) throw new Error(`${id} doesn't exist on Hugging Face`);
  if (!response.ok) throw new Error(`Hugging Face answered ${response.status}`);
  const { siblings } = (await response.json()) as { siblings?: { rfilename: string }[] };
  const dtypes = (siblings ?? [])
    .map(({ rfilename }) => (rfilename.startsWith("onnx/") ? DTYPE_FILES[rfilename.slice(5)] : undefined))
    .filter((dtype): dtype is Dtype => !!dtype);
  if (!dtypes.length) throw new Error(`${id} has no ONNX weights, so it can't run in the browser`);
  return [...new Set(dtypes)];
}

function ModelPicker() {
  const [cached, setCached] = useState<CachedModel[]>([]);
  const [repo, setRepo] = useState("");
  const [available, setAvailable] = useState<Dtype[] | null>(null);
  const [dtype, setDtype] = useState<Dtype>("fp32");
  const [jobId, setJobId] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const job = jobs.value.find((j) => j.id === jobId);
  const active = settings.value.model;

  const reload = () => listCached().then(setCached).catch(showError);
  useEffect(() => { reload(); }, [job?.status]);

  const activate = async (config: ModelConfig) => {
    await updateSettings({ model: config });
    await refreshActive();
  };
  const select = (id: string, dtypes: string[]) => {
    const next = dtypes.includes(active.dtype) ? active.dtype : ((dtypes[0] as Dtype) ?? "fp32");
    return activate({ ...active, id, dtype: next, pooling: recommendedPooling(id) });
  };
  const test = async () => {
    setTested("testing…");
    try {
      const { dims, ms } = await call("testModel", { model: active });
      setTested(`${dims} dimensions, ${ms} ms for one sentence`);
    } catch (error) {
      setTested(null);
      showError(error);
    }
  };
  const check = async (event: Event) => {
    event.preventDefault();
    setAvailable(null);
    try {
      const dtypes = await inspectRepo(repo.trim());
      setAvailable(dtypes);
      setDtype(dtypes.includes("fp32") ? "fp32" : dtypes[0]);
    } catch (error) {
      showError(error);
    }
  };
  const download = () => {
    const config: ModelConfig = { ...active, id: repo.trim(), dtype, pooling: recommendedPooling(repo) };
    call<string>("download", { model: config })
      .then((id) => { setJobId(id); return activate(config); })
      .catch(showError);
  };

  const rows = [...cached.map((m) => m.id), ...OPENAI_MODELS];
  if (!rows.includes(active.id)) rows.unshift(active.id);

  return (
    <section class="panel">
      <h2>Models</h2>
      <table class="table table-sm align-middle">
        <thead><tr><th scope="col">Model</th><th scope="col">Weights</th><th scope="col" class="text-end">Size</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
          {rows.map((id) => {
            const model = cached.find((m) => m.id === id);
            const openai = id.startsWith("openai/");
            const isActive = id === active.id;
            return (
              <tr key={id}>
                <td class="text-break">
                  {openai ? id : <a href={`https://huggingface.co/${id}`} target="_blank" rel="noreferrer">{id}</a>}
                  {isActive && <span class="badge text-bg-primary ms-2">active</span>}
                </td>
                <td>{openai ? "API" : (model?.dtypes.join(", ") || "–")}</td>
                <td class="text-end">{formatBytes(model?.size ?? 0)}</td>
                <td class="text-end text-nowrap">
                  {!isActive && <button type="button" class="btn btn-sm btn-outline-primary me-1" onClick={() => select(id, model?.dtypes ?? []).catch(showError)}>Use</button>}
                  {model && <button type="button" class="btn btn-sm btn-outline-danger" aria-label={`Delete ${id}`} onClick={() => deleteCached(id).then(reload).catch(showError)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <form class="mb-2" onSubmit={check}>
        <label class="form-label" for="repo">Add a model from Hugging Face</label>
        <div class="input-group">
          <span class="input-group-text">huggingface.co/</span>
          <input id="repo" class="form-control" placeholder="Xenova/all-mpnet-base-v2" value={repo} onInput={(e) => { setRepo(e.currentTarget.value); setAvailable(null); }} />
          <button class="btn btn-outline-primary" disabled={!repo.trim()}>Check</button>
        </div>
      </form>
      {available && (
        <div class="d-flex gap-2 align-items-center mb-2">
          <label class="small" for="dtype">Weights</label>
          <select id="dtype" class="form-select form-select-sm w-auto" value={dtype} onChange={(e) => setDtype(e.currentTarget.value as Dtype)}>
            {available.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <button type="button" class="btn btn-sm btn-primary" onClick={download}>Download and use</button>
        </div>
      )}
      <div class="d-flex gap-2 align-items-center mt-3">
        <button type="button" class="btn btn-sm btn-outline-secondary" data-testid="test-model" onClick={test}>Test active model</button>
        {tested && <span class="small" data-testid="test-result">{tested}</span>}
      </div>
    </section>
  );
}

function ActiveModelOptions() {
  const active = settings.value.model;
  if (active.id.startsWith("openai/")) return null;
  const change = (patch: Partial<ModelConfig>) =>
    updateSettings({ model: { ...active, ...patch } }).then(refreshActive).catch(showError);
  const recommended = recommendedPooling(active.id);
  const others = coverage.value.filter((c) => c.modelKey !== modelKey(active));

  return (
    <section class="panel">
      <h2>Active model options</h2>
      <div class="row g-3">
        <div class="col-sm-4">
          <label class="form-label" for="pooling">Pooling</label>
          <select id="pooling" class="form-select" value={active.pooling} onChange={(e) => change({ pooling: e.currentTarget.value as Pooling })}>
            <option value="mean">mean{recommended === "mean" ? " (recommended)" : ""}</option>
            <option value="cls">cls{recommended === "cls" ? " (recommended)" : ""}</option>
          </select>
        </div>
        <div class="col-sm-4">
          <label class="form-label" for="weights">Weights</label>
          <select id="weights" class="form-select" value={active.dtype} onChange={(e) => change({ dtype: e.currentTarget.value as Dtype })}>
            {["fp32", "fp16", "q8", "q4", "q4f16"].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div class="col-sm-4">
          <label class="form-label" for="device">Runs on</label>
          <select id="device" class="form-select" value={active.device} onChange={(e) => change({ device: e.currentTarget.value as Device })}>
            <option value="wasm">CPU (WASM)</option>
            <option value="webgpu">GPU (WebGPU)</option>
          </select>
        </div>
      </div>
      <p class="field-help mt-2 mb-0">
        Pooling and weights change the vectors, so each combination keeps its own embeddings.
        {activeDataset.value && others.length > 0 && ` ${activeDataset.value.name} also has: ${others.map((c) => describeModelKey(c.modelKey)).join(", ")}.`}
      </p>
    </section>
  );
}

function OpenAiKey() {
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState("");
  const [shown, setShown] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  useEffect(() => {
    loadOpenAiKey().then((stored) => { setKey(stored); setSaved(stored); }).catch(showError);
  }, []);
  const save = (value: string) =>
    saveOpenAiKey(value)
      .then(() => {
        setKey(value);
        setSaved(value);
        setTested(null);
        showSuccess(value ? "OpenAI key saved." : "OpenAI key removed.");
      })
      .catch(showError);
  const test = async () => {
    setTested("testing…");
    try {
      const { dims, ms } = await call("testOpenAi");
      setTested(`Key works: ${dims} dimensions, ${ms} ms`);
    } catch (error) {
      setTested(null);
      showError(error);
    }
  };
  return (
    <section class="panel">
      <h2>OpenAI</h2>
      <label class="form-label" for="openai-key">API key</label>
      <div class="input-group">
        <input id="openai-key" class="form-control" {...{ type: shown ? "text" : "password" } as any} autoComplete="off" value={key} onInput={(e) => setKey(e.currentTarget.value)} />
        <button type="button" class="btn btn-outline-secondary" aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>
        <button type="button" class="btn btn-primary" disabled={!key.trim()} onClick={() => save(key.trim())}>Save</button>
        <button type="button" class="btn btn-outline-secondary" data-testid="openai-test" disabled={!saved || key.trim() !== saved} onClick={test}>Test</button>
        <button type="button" class="btn btn-outline-danger" onClick={() => save("")}>Clear</button>
      </div>
      {tested && <p class="small mt-2 mb-0" data-testid="openai-test-result">{tested}</p>}
      <p class="field-help mt-2 mb-0">Stored unencrypted in this browser profile. Only the background page uses it, to call OpenAI. Test embeds one word with text-embedding-3-small, which is billed to your key.</p>
    </section>
  );
}

function Storage() {
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  useEffect(() => { navigator.storage.estimate().then(setEstimate).catch(showError); }, []);
  return (
    <section class="panel">
      <h2>Storage</h2>
      <p class="mb-0">{estimate ? `${formatBytes(estimate.usage ?? 0)} used, by datasets and downloaded models together.` : "Measuring…"}</p>
    </section>
  );
}

export function ModelsView() {
  return (
    <div class="page">
      <ModelPicker />
      <ActiveModelOptions />
      <OpenAiKey />
      <Storage />
    </div>
  );
}

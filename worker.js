// Runs Whisper in a background thread so the page never freezes.
//
// Where files come from (first match wins):
//   library : ./vendor/ on this site  ->  jsDelivr CDN
//   models  : ./models/ on this site  ->  Hugging Face
// The GitHub Actions workflow in this repo fills ./vendor and ./models, which
// makes the deployed site fully self-contained. Without it, the CDN and
// Hugging Face fallbacks still work.

const TF_VERSION = "3.5.1";
const CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TF_VERSION}/dist/`;

// CPU models come from Xenova (quantized 8-bit, runs on any machine).
// GPU models come from onnx-community (larger, much faster in Chrome/Edge).
const MODELS = {
  tiny:  { cpu: "Xenova/whisper-tiny",  gpu: "onnx-community/whisper-tiny" },
  base:  { cpu: "Xenova/whisper-base",  gpu: "onnx-community/whisper-base" },
  small: { cpu: "Xenova/whisper-small", gpu: "onnx-community/whisper-small" },
};

const SAMPLE_RATE = 16000;
const CHUNK_S = 30;   // Whisper's window
const STRIDE_S = 5;   // overlap on each side, merged automatically

let T = null;          // transformers.js module
let libSource = "";
let current = { key: "", asr: null, device: "" };
let lastFile = "";     // last file we tried to download, for error messages

const post = (msg) => self.postMessage(msg);

async function loadLibrary() {
  if (T) return T;
  try {
    T = await import("./vendor/transformers.min.js");
    libSource = "this site";
    wasmEnv().wasmPaths = new URL("./vendor/", self.location.href).href;
  } catch (localErr) {
    T = await import(/* @vite-ignore */ CDN + "transformers.min.js");
    libSource = "cdn.jsdelivr.net";
    wasmEnv().wasmPaths = CDN;
  }
  T.env.allowLocalModels = true;
  T.env.localModelPath = new URL("./models/", self.location.href).href;
  T.env.allowRemoteModels = true;
  T.env.useBrowserCache = true;

  // Extra CPU threads need cross-origin isolation, which plain GitHub Pages
  // does not provide. Use them automatically when the page is isolated.
  const cores = self.navigator?.hardwareConcurrency || 2;
  wasmEnv().numThreads = self.crossOriginIsolated ? Math.min(4, cores) : 1;
  return T;
}

// ONNX Runtime settings object (empty stand-in if the runtime did not initialise).
function wasmEnv() {
  return T.env.backends.onnx?.wasm ?? {};
}

async function gpuAvailable() {
  try {
    if (!self.navigator?.gpu) return false;
    return !!(await self.navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

function makeProgressCallback(label) {
  return (p) => {
    if (p.file) lastFile = p.file;
    if (p.status === "progress" && p.total) {
      post({ type: "download", label, file: p.file, loaded: p.loaded, total: p.total, progress: p.progress });
    } else if (p.status === "ready") {
      post({ type: "status", text: "Model ready." });
    }
  };
}

async function buildPipeline(size, device) {
  const id = MODELS[size][device === "gpu" ? "gpu" : "cpu"];
  post({ type: "status", text: `Loading ${size} model (${device === "gpu" ? "GPU" : "CPU"})...` });
  const options = device === "gpu"
    ? { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } }
    : { device: "wasm", dtype: "q8" };
  const asr = await T.pipeline("automatic-speech-recognition", id, {
    ...options,
    progress_callback: makeProgressCallback(id),
  });
  return asr;
}

async function getPipeline(size, requested) {
  await loadLibrary();
  const wantGpu = requested === "gpu" || (requested === "auto" && (await gpuAvailable()));

  if (wantGpu) {
    const key = `${size}:gpu`;
    if (current.key === key) return current;
    try {
      const asr = await buildPipeline(size, "gpu");
      current = { key, asr, device: "gpu" };
      return current;
    } catch (err) {
      if (requested === "gpu") throw err;
      post({ type: "status", text: "GPU mode failed, switching to CPU." });
      console.warn("GPU pipeline failed:", err);
    }
  }
  const key = `${size}:cpu`;
  if (current.key === key) return current;
  const asr = await buildPipeline(size, "cpu");
  current = { key, asr, device: "cpu" };
  return current;
}

async function run({ audio, size, device, language, task }) {
  const { asr, device: usedDevice } = await getPipeline(size, device);

  const duration = audio.length / SAMPLE_RATE;
  const jump = CHUNK_S - 2 * STRIDE_S;
  const totalWindows = duration <= CHUNK_S ? 1 : Math.ceil((duration - CHUNK_S) / jump) + 1;

  post({
    type: "start",
    device: usedDevice,
    library: libSource,
    threads: wasmEnv().numThreads ?? 1,
    totalWindows,
    duration,
  });

  const timePrecision =
    asr.processor.feature_extractor.config.chunk_length / asr.model.config.max_source_positions;

  let done = 0;
  const streamer = new T.WhisperTextStreamer(asr.tokenizer, {
    skip_prompt: true,
    time_precision: timePrecision,
    callback_function: (text) => post({ type: "live", text }),
    on_finalize: () => {
      done += 1;
      post({ type: "progress", done: Math.min(done, totalWindows), total: totalWindows });
    },
  });

  const options = {
    chunk_length_s: CHUNK_S,
    stride_length_s: STRIDE_S,
    return_timestamps: true,
    force_full_sequences: false,
    task,
    top_k: 0,
    do_sample: false, // greedy decoding: fastest, deterministic
    streamer,
  };
  if (language && language !== "auto") options.language = language;

  const out = await asr(audio, options);
  const chunks = (out.chunks || [{ timestamp: [0, duration], text: out.text }])
    .map((c) => ({
      start: c.timestamp?.[0] ?? 0,
      end: c.timestamp?.[1] ?? Math.min(duration, (c.timestamp?.[0] ?? 0) + 5),
      text: (c.text || "").trim(),
    }))
    .filter((c) => c.text);

  post({ type: "done", chunks });
}

self.addEventListener("message", async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "run") await run(msg);
    else if (msg.type === "preload") {
      await getPipeline(msg.size, msg.device);
      post({ type: "preloaded" });
    }
  } catch (err) {
    console.error(err);
    post({
      type: "error",
      message: String(err?.message || err),
      file: lastFile,
      library: libSource,
    });
  }
});

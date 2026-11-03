// Lightweight two-speaker detection (moderator / stakeholder) from the audio itself.
// No model download: it measures each sentence's voice (spectral shape and pitch), splits the
// sentences into two groups, smooths out flicker, then decides which group is the moderator
// from the text (who asks the questions, who talks less). Pure JS, so it runs in a worker or Node.

const SR = 16000;
const FRAME = 512;                 // 32 ms
const HOP = 320;                   // 20 ms
const HOP_S = HOP / SR;
const NMEL = 40;
const NMFCC = 20;
const DIM = NMFCC + 1;             // MFCC means + log pitch
const PITCH_WEIGHT = 1.5;
const VOICED_THRESHOLD = 0.12;     // cepstral peak height that counts as voiced

/* ---------- FFT ---------- */

function makeFFT(n) {
  const levels = Math.log2(n);
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const rev = new Uint16Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, wr = cos[k], wi = -sin[k];
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}
const fft = makeFFT(FRAME);
const HANN = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));

const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);
const MEL = (() => {
  const mmin = hz2mel(100), mmax = hz2mel(7600);
  const bins = Array.from({ length: NMEL + 2 }, (_, i) => (mel2hz(mmin + ((mmax - mmin) * i) / (NMEL + 1)) * FRAME) / SR);
  const filters = [];
  for (let m = 1; m <= NMEL; m++) {
    const lo = bins[m - 1], c = bins[m], hi = bins[m + 1];
    const start = Math.floor(lo), end = Math.min(FRAME / 2, Math.ceil(hi));
    const w = [];
    for (let k = start; k <= end; k++) w.push(Math.max(0, k <= c ? (k - lo) / (c - lo) : (hi - k) / (hi - c)));
    filters.push({ start, w: Float64Array.from(w) });
  }
  return filters;
})();
const DCT = Array.from({ length: NMFCC }, (_, c) =>
  Float64Array.from({ length: NMEL }, (_, m) => Math.cos((Math.PI * (c + 1) * (m + 0.5)) / NMEL)));

/* ---------- frame features ---------- */

/**
 * Per-frame features. Quiet frames (silence, background noise) are skipped.
 * Returns { n, speech, mfcc, f0 } where f0 is 0 for unvoiced frames.
 */
export function computeFrames(audio) {
  const n = audio.length >= FRAME ? Math.floor((audio.length - FRAME) / HOP) + 1 : 0;
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; const o = i * HOP;
    for (let j = 0; j < FRAME; j++) { const x = audio[o + j]; s += x * x; }
    energy[i] = 10 * Math.log10(s / FRAME + 1e-10);
  }
  const speech = new Uint8Array(n), mfcc = new Float32Array(n * NMFCC), f0 = new Float32Array(n);
  if (!n) return { n, speech, mfcc, f0 };

  const sorted = Float32Array.from(energy).sort();
  const floor = sorted[Math.floor(n * 0.1)], high = sorted[Math.min(n - 1, Math.floor(n * 0.9))];
  const threshold = Math.max(high - 35, floor + 0.3 * (high - floor));

  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  const power = new Float64Array(FRAME / 2 + 1), logE = new Float64Array(NMEL);
  for (let i = 0; i < n; i++) {
    if (energy[i] < threshold) continue;
    speech[i] = 1;
    const o = i * HOP;
    for (let j = 0; j < FRAME; j++) {
      const prev = j ? audio[o + j - 1] : o ? audio[o - 1] : 0;
      re[j] = (audio[o + j] - 0.97 * prev) * HANN[j]; im[j] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= FRAME / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    for (let m = 0; m < NMEL; m++) {
      const f = MEL[m]; let e = 0;
      for (let q = 0; q < f.w.length; q++) e += f.w[q] * power[f.start + q];
      logE[m] = Math.log(e + 1e-10);
    }
    for (let c = 0; c < NMFCC; c++) {
      let v = 0; const row = DCT[c];
      for (let m = 0; m < NMEL; m++) v += logE[m] * row[m];
      mfcc[i * NMFCC + c] = v;
    }

    // pitch from the real cepstrum (a peak at the pitch period)
    for (let k = 0; k <= FRAME / 2; k++) { re[k] = Math.log(power[k] + 1e-10); im[k] = 0; }
    for (let k = FRAME / 2 + 1; k < FRAME; k++) { re[k] = re[FRAME - k]; im[k] = 0; }
    fft(re, im);
    let best = 0, bestQ = 0;
    for (let q = 40; q <= 228; q++) { const v = re[q] / FRAME; if (v > best) { best = v; bestQ = q; } }
    if (best > VOICED_THRESHOLD) f0[i] = SR / bestQ;
  }
  return { n, speech, mfcc, f0 };
}

const median = (a) => { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

/** Voice fingerprint of frames [i0, i1), or null if there is too little speech. */
function frameFeature(fr, i0, i1) {
  const sum = new Float64Array(NMFCC), pitches = [];
  let count = 0;
  for (let i = Math.max(0, i0); i < Math.min(fr.n, i1); i++) {
    if (!fr.speech[i]) continue;
    count++;
    for (let c = 0; c < NMFCC; c++) sum[c] += fr.mfcc[i * NMFCC + c];
    if (fr.f0[i] > 0) pitches.push(fr.f0[i]);
  }
  if (count < 10) return null;                            // under 0.2 s of speech
  const v = new Float64Array(DIM);
  for (let c = 0; c < NMFCC; c++) v[c] = sum[c] / count;
  v[NMFCC] = pitches.length >= 5 ? Math.log(median(pitches)) : NaN;
  return { v, w: count };
}

/**
 * Cut the audio into speech bursts (separated by pauses) and split long bursts into short windows.
 * Working on the audio timeline, rather than on the transcript's approximate times, keeps speaker
 * changes lined up with the pauses where they really happen.
 */
export function makeWindows(fr, { gapFrames = 12, windowSeconds = 2.5 } = {}) {
  const wins = [];
  let i = 0;
  while (i < fr.n) {
    if (!fr.speech[i]) { i++; continue; }
    let start = i, last = i;
    while (i < fr.n && i - last <= gapFrames) { if (fr.speech[i]) last = i; i++; }
    const end = last + 1;                                  // burst = [start, end)
    const len = (end - start) * HOP_S;
    if (len < 0.3) continue;
    const parts = Math.max(1, Math.round(len / windowSeconds));
    for (let k = 0; k < parts; k++) {
      const a = start + Math.round(((end - start) * k) / parts), b = start + Math.round(((end - start) * (k + 1)) / parts);
      const f = frameFeature(fr, a, b);
      if (f) wins.push({ t0: a * HOP_S, t1: b * HOP_S, burst: start, f });
    }
  }
  return wins;
}

/* ---------- clustering and smoothing ---------- */

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dist2 = (a, b) => { let s = 0; for (let d = 0; d < a.length; d++) { const x = a[d] - b[d]; s += x * x; } return s; };

function kmeans2(X, W, restarts = 25) {
  const n = X.length, D = X[0].length;
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const rnd = mulberry32(1000 + r);
    const c0 = X[Math.floor(rnd() * n)];
    // k-means++: pick the second centre far from the first
    const d = X.map((x, i) => dist2(x, c0) * W[i]);
    const total = d.reduce((a, b) => a + b, 0);
    let pick = rnd() * total, idx = 0;
    for (; idx < n - 1; idx++) { pick -= d[idx]; if (pick <= 0) break; }
    const cent = [Float64Array.from(c0), Float64Array.from(X[idx])];
    const labels = new Int8Array(n);
    for (let it = 0; it < 60; it++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        const l = dist2(X[i], cent[0]) <= dist2(X[i], cent[1]) ? 0 : 1;
        if (l !== labels[i]) { labels[i] = l; changed = true; }
      }
      const sums = [new Float64Array(D), new Float64Array(D)], ws = [0, 0];
      for (let i = 0; i < n; i++) { const l = labels[i]; ws[l] += W[i]; for (let k = 0; k < D; k++) sums[l][k] += W[i] * X[i][k]; }
      for (let l = 0; l < 2; l++) if (ws[l] > 0) for (let k = 0; k < D; k++) cent[l][k] = sums[l][k] / ws[l];
      if (!changed && it > 0) break;
    }
    let inertia = 0;
    for (let i = 0; i < n; i++) inertia += W[i] * dist2(X[i], cent[labels[i]]);
    if (!best || inertia < best.inertia) best = { cent, labels: Int8Array.from(labels), inertia };
  }
  return best;
}

/** Most likely sequence of two states given per-item costs and per-transition switch penalties. */
function viterbi2(costs, penalty) {
  const n = costs.length;
  const back = new Int8Array(n * 2);
  let p0 = costs[0][0], p1 = costs[0][1];
  for (let i = 1; i < n; i++) {
    const l = penalty[i];
    const stay0 = p0, move0 = p1 + l, stay1 = p1, move1 = p0 + l;
    back[i * 2] = stay0 <= move0 ? 0 : 1;
    back[i * 2 + 1] = stay1 <= move1 ? 1 : 0;
    const n0 = Math.min(stay0, move0) + costs[i][0], n1 = Math.min(stay1, move1) + costs[i][1];
    p0 = n0; p1 = n1;
  }
  const path = new Int8Array(n);
  let s = p0 <= p1 ? 0 : 1;
  for (let i = n - 1; i >= 0; i--) { path[i] = s; s = back[i * 2 + s]; }
  return path;
}

const QUESTION_END = /[?\u061F]["\u201D\u2019')\]]*\s*$/;
const wordCount = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/**
 * Label every sentence "mod" or "stk".
 * sentences: [{ start, end, text }] (times only need to be roughly right); audio: Float32Array at 16 kHz.
 * Returns { speakers, info } or null when there is not enough speech to tell two voices apart.
 * info: { separation, confidence: "high"|"medium"|"low", switches, usable, total }
 */
export function diarize(audio, sentences, opts = {}) {
  const fr = opts.frames || computeFrames(audio);
  const wins = makeWindows(fr);
  if (wins.length < 8) return null;

  // 1) voices on the audio timeline: standardise features, split into two groups
  const mean = new Float64Array(DIM), sd = new Float64Array(DIM), cnt = new Float64Array(DIM), wsum = new Float64Array(DIM);
  for (const wn of wins) for (let d = 0; d < DIM; d++) {
    const x = wn.f.v[d]; if (Number.isNaN(x)) continue;
    const w = Math.sqrt(wn.f.w); mean[d] += w * x; wsum[d] += w;
  }
  for (let d = 0; d < DIM; d++) mean[d] = wsum[d] ? mean[d] / wsum[d] : 0;
  for (const wn of wins) for (let d = 0; d < DIM; d++) {
    const x = wn.f.v[d]; if (Number.isNaN(x)) continue;
    const w = Math.sqrt(wn.f.w); sd[d] += w * (x - mean[d]) ** 2; cnt[d] += w;
  }
  for (let d = 0; d < DIM; d++) sd[d] = Math.sqrt(cnt[d] ? sd[d] / cnt[d] : 1) || 1;
  const X = wins.map((wn) => Float64Array.from(wn.f.v, (x, d) => (Number.isNaN(x) ? 0 : ((x - mean[d]) / sd[d]) * (d === NMFCC ? PITCH_WEIGHT : 1))));
  const W = wins.map((wn) => Math.sqrt(wn.f.w));
  const km = kmeans2(X, W);
  const [c0, c1] = km.cent;

  // how far apart are the two voices, measured along the line between them
  const delta = Math.sqrt(dist2(c0, c1));
  const axis = Float64Array.from(c0, (v, d) => (c1[d] - v) / (delta || 1));
  const dot = (x) => x.reduce((s, v, d) => s + v * axis[d], 0);
  const m0 = dot(c0), m1 = dot(c1);
  let ss = 0, sw = 0;
  X.forEach((x, k) => { const m = km.labels[k] ? m1 : m0; ss += W[k] * (dot(x) - m) ** 2; sw += W[k]; });
  const separation = delta / (Math.sqrt(ss / sw) || 1);

  // 2) smooth over time: a change of voice inside a burst of speech is rare, after a pause it is normal
  const costs = X.map((x) => [dist2(x, c0) / DIM, dist2(x, c1) / DIM]);
  const diffs = costs.map((c) => Math.abs(c[0] - c[1])).sort((a, b) => a - b);
  const scale = diffs[diffs.length >> 1] || 1;
  const penalty = wins.map((wn, k) => {
    if (!k) return 0;
    const gap = wn.t0 - wins[k - 1].t1;
    return scale * (gap < 0.05 ? 1.8 : gap < 0.5 ? 1.0 : 0.55);
  });
  const winPath = viterbi2(costs, penalty);

  // 3) hand the voices to the sentences: each sentence takes the voice that covers most of its time
  const frac = sentences.map((s) => {
    const o = [0, 0];
    for (let k = 0; k < wins.length; k++) {
      if (wins[k].t1 <= s.start) continue;
      if (wins[k].t0 >= s.end) break;
      o[winPath[k]] += Math.min(s.end, wins[k].t1) - Math.max(s.start, wins[k].t0);
    }
    const t = o[0] + o[1];
    return t > 0.05 ? [o[0] / t, o[1] / t] : null;
  });
  // sentences with no audio of their own take the voice of their nearest neighbour
  const labelOf = (i) => (frac[i] ? (frac[i][0] >= frac[i][1] ? 0 : 1) : -1);
  const first = sentences.map((s, i) => {
    let l = labelOf(i);
    if (l < 0) { for (let d = 1; d < sentences.length && l < 0; d++) l = labelOf(i - d) >= 0 ? labelOf(i - d) : labelOf(i + d); }
    return l < 0 ? 0 : l;
  });

  // 4) who is the moderator? the voice that asks the questions, talks less and speaks first
  const stat = [0, 1].map(() => ({ sentences: 0, questions: 0, words: 0, first: Infinity }));
  sentences.forEach((s, i) => {
    const text = (s.text || "").trim();
    if (!text) return;
    const st = stat[first[i]];
    st.sentences++; st.words += wordCount(text);
    if (QUESTION_END.test(text)) st.questions++;
    if (i < st.first) st.first = i;
  });
  const total = stat[0].words + stat[1].words || 1;
  const qRatio = stat.map((s) => (s.sentences ? s.questions / s.sentences : 0));
  const scoreFor0 = 3 * (qRatio[0] - qRatio[1]) + (stat[1].words - stat[0].words) / total + (stat[0].first < stat[1].first ? 0.3 : -0.3);
  const mod = scoreFor0 >= 0 ? 0 : 1;

  // 5) final pass over sentences: audio evidence, a lean towards "question = moderator", and turn-taking
  const costs2 = sentences.map((s, i) => {
    const f = frac[i] || [0.5, 0.5];
    const c = [1 - f[0], 1 - f[1]];
    if (QUESTION_END.test((s.text || "").trim())) c[1 - mod] += 0.3;
    return c;
  });
  // The audio windows were already smoothed with real pause information, and the sentence times are only
  // estimates, so keep this pass light: it mostly settles short sentences with weak evidence.
  const pen2 = sentences.map((s, i) => (i ? 0.2 : 0));
  const path = viterbi2(costs2, pen2);

  const speakers = sentences.map((s, i) => ((s.text || "").trim() ? (path[i] === mod ? "mod" : "stk") : null));
  let switches = 0;
  for (let i = 1; i < path.length; i++) if (path[i] !== path[i - 1]) switches++;
  const strength = Math.abs(scoreFor0);
  const confidence = separation < 4 || strength < 0.25 ? "low" : separation < 5.5 || strength < 0.6 ? "medium" : "high";
  return {
    speakers,
    info: { separation: Math.round(separation * 100) / 100, roleScore: Math.round(strength * 100) / 100, confidence, switches, usable: frac.filter(Boolean).length, total: sentences.length },
  };
}

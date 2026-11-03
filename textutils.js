// Pure helpers (no DOM) so they can be tested in Node and reused by the page.
// Everything here works on plain text and never touches the network.

/* ------------------------------------------------------------------ */
/* Time and text helpers                                              */
/* ------------------------------------------------------------------ */

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** 00:01:23 (or 00:01:23,450 / 00:01:23.450 when a millisecond separator is given). */
export function stamp(t, msSep = null) {
  t = Math.max(0, Number(t) || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return msSep ? `${base}${msSep}${pad(Math.floor((t % 1) * 1000), 3)}` : base;
}

export const isRTL = (s) => /[\u0590-\u08FF]/.test(s || "");

/** Split on commas, semicolons and new lines; trim; drop empties. */
export function splitList(s) {
  return String(s || "").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ------------------------------------------------------------------ */
/* Filler removal                                                     */
/* ------------------------------------------------------------------ */

const S1 = "\u0001"; // marks a removed filler
const S2 = "\u0002"; // marks a removed filler that started with a capital letter
const LET = "\\p{L}\\p{M}\\p{N}";
// A filler must stand alone: not inside a word, and not part of "uh-huh".
const BEFORE = `(?<![${LET}_'\u2019\\-])`;
const AFTER = `(?![${LET}_'\u2019\\-])`;

// Hesitation sounds. They are matched case-sensitively on purpose so that
// acronyms such as "ER" or "UH" are left alone, and "err on the side" survives.
const SOUND_SETS = {
  universal: ["[Uu]+h+", "[Hh]+m+", "[Mm]{2,}"],
  en: ["[Uu]+m+", "[Ee]r", "[Ee]rm+"],
  fr: ["[Ee]+u+h+", "[Hh]e+u+", "[Hh]u+m+", "[Uu]+m+"],
  de: ["[\u00C4\u00E4]+h+m*", "[Ee]+h+m+"],
  ar: ["[\u0627\u0625\u0623]\u0645{3,}", "\u0645{3,}", "\u0627{3,}"],
};
// "um" is a real word in Portuguese and German, "er" is one in German, so each
// language only gets the sounds that are safe for it.
const LANG_SETS = {
  english: ["en"],
  french: ["fr"],
  arabic: ["ar"],
  german: ["de"],
  auto: ["en", "fr", "ar"],
};
// Short answers that carry meaning, so they stay unless the user asks.
const BACKCHANNEL = [
  "[Mm]+-[Hh]+m+", "[Mm]+-[Mm]+", "[Mm]+h+m+",
  "[Uu]+h+-[Hh]+u+h+", "[Uu]+h+-[Uu]+h+", "[Hh]+m+-[Hh]+m+",
];

function soundRegex(opts) {
  const pats = [];
  if (opts.backchannel) pats.push(...BACKCHANNEL);
  if (opts.fillers) {
    pats.push(...SOUND_SETS.universal);
    for (const key of LANG_SETS[(opts.lang || "auto").toLowerCase()] || []) pats.push(...SOUND_SETS[key]);
  }
  return pats.length ? new RegExp(`${BEFORE}(?:${pats.join("|")})${AFTER}`, "gu") : null;
}

function customRegex(list) {
  const words = (list || []).map((w) => w.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!words.length) return null;
  const alts = words.map((w) => escapeRx(w).replace(/\s+/g, "\\s+"));
  return new RegExp(`${BEFORE}(?:${alts.join("|")})${AFTER}`, "giu");
}

function markRemovals(text, rx, counter) {
  return text.replace(rx, (m, offset, str) => {
    // "5 mm" is a measurement, not a hesitation.
    if (/^m{2,}$/.test(m) && /\d\s*$/.test(str.slice(Math.max(0, offset - 3), offset))) return m;
    counter.n += 1;
    return /^\p{Lu}/u.test(m) ? S2 : S1;
  });
}

function tidy(t) {
  // A removed capitalised filler ("Um, so ...") passes its capital to the next word.
  t = t.replace(new RegExp(`${S2}[\\s,;\u060C\u2026]*(?:\\.{2,}[\\s,;\u060C\u2026]*)?(\\p{Ll})`, "gu"),
    (m, ch) => ch.toLocaleUpperCase());
  // Drop the remaining markers together with the separators that followed them.
  t = t.replace(new RegExp(`[${S1}${S2}][\\s,;\u060C\u2026]*(?:\\.{2,}[\\s,;\u060C\u2026]*)?`, "gu"), "");
  t = t.replace(/([.?!\u061F])\s+\.(?!\.)/gu, "$1");          // "Yeah. ." -> "Yeah."
  t = t.replace(/\s+([,.;:!?\u2026\u061F\u060C])/gu, "$1");     // no space before punctuation
  t = t.replace(/([,;\u060C])(?:\s*[,;\u060C])+/gu, "$1");     // ", ," -> ","
  t = t.replace(/([,;\u060C])\s*([.?!\u2026\u061F])/gu, "$2");  // ",." -> "."
  t = t.replace(/^[\s,;\u060C.\u2026]+/u, "");                 // nothing dangling at the start
  t = t.replace(/[\s,;\u060C]+$/u, "");                        // or the end
  t = t.replace(/\s{2,}/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : "";
}

/**
 * Remove filler sounds from one piece of text.
 * opts: { fillers, backchannel, repeats, custom: string[], lang }
 * Returns { text, removed } where removed counts everything taken out.
 */
export function cleanText(text, opts = {}) {
  const src = String(text ?? "");
  if (!opts.fillers && !opts.backchannel && !opts.repeats && !(opts.custom && opts.custom.length)) {
    return { text: src.trim(), removed: 0 };
  }
  try {
    const counter = { n: 0 };
    let t = src;
    const sounds = soundRegex(opts);
    if (sounds) t = markRemovals(t, sounds, counter);
    const custom = customRegex(opts.custom);
    if (custom) t = markRemovals(t, custom, counter);
    t = tidy(t);
    if (opts.repeats) {
      const rep = new RegExp(`(?<![${LET}_'\u2019])([\\p{L}\\p{M}]+)(?:[,\\s]+\\1)+(?![${LET}_'\u2019])`, "giu");
      t = t.replace(rep, (m, word) => {
        counter.n += m.split(/[,\s]+/).filter(Boolean).length - 1;
        return word;
      });
      t = tidy(t);
    }
    return { text: t, removed: counter.n };
  } catch {
    // Very old browsers without lookbehind support: leave the text untouched.
    return { text: src.trim(), removed: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Glossary                                                           */
/* ------------------------------------------------------------------ */

/** Lines such as  duchen => Duchenne   (also -> and the arrow character). */
export function parseGlossary(s) {
  const out = [];
  for (const raw of String(s || "").split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s*(?:=>|->|\u2192)\s*/);
    if (parts.length < 2) continue;
    const from = parts[0].trim(), to = parts.slice(1).join(" ").trim();
    if (from && to) out.push({ from, to });
  }
  return out.sort((a, b) => b.from.length - a.from.length);
}

export function applyGlossary(text, entries) {
  if (!entries || !entries.length || !text) return text;
  let t = text;
  try {
    for (const { from, to } of entries) {
      const rx = new RegExp(`${BEFORE}${escapeRx(from).replace(/\s+/g, "\\s+")}${AFTER}`, "giu");
      t = t.replace(rx, () => to);
    }
  } catch { /* leave text as is */ }
  return t;
}

/**
 * The text actually shown and exported for a segment.
 * A manual edit always wins over automatic clean-up.
 */
export function effectiveText(seg, opts, glossary) {
  if (seg.edit !== null && seg.edit !== undefined) return { text: String(seg.edit).trim(), removed: 0 };
  const r = cleanText(seg.text, opts);
  return { text: applyGlossary(r.text, glossary).trim(), removed: r.removed };
}

/* ------------------------------------------------------------------ */
/* Speaker roles                                                      */
/* ------------------------------------------------------------------ */

const QUESTION_END = /[?\u061F]["\u201D\u2019')\]]*\s*$/;

/**
 * Rough first pass at who is who, from text alone.
 * A line ending in a question mark is the moderator. Lines before the first question
 * are treated as the moderator's introduction, and every non-question line after a
 * question belongs to the stakeholder until the next question.
 * items: [{ text }]. Returns an array of "mod" | "stk" | null (null for empty lines),
 * or null when there are no questions at all (nothing sensible to suggest).
 */
export function suggestRoles(items) {
  const isQ = (t) => QUESTION_END.test(t);
  const firstQ = items.findIndex((it) => it.text && isQ(it.text.trim()));
  if (firstQ === -1) return null;
  let role = "mod";
  return items.map((it, i) => {
    const text = (it.text || "").trim();
    if (!text) return null;
    if (isQ(text)) role = "mod";
    else if (i > firstQ) role = "stk";
    return role;
  });
}

/* ------------------------------------------------------------------ */
/* Sentence reflow                                                    */
/* ------------------------------------------------------------------ */

// Tokens that end in a full stop without ending a sentence.
const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "approx", "no", "fig",
  "inc", "ltd", "co", "dept", "ref", "vol", "al", "mt", "ave", "mm", "cm", "kg", "mg", "ml", "u.s", "u.k",
]);
const TERMINAL = /[.?!\u061F\u2026]["\u201D\u2019')\]]*$/u;

function endsSentence(word, next) {
  if (!TERMINAL.test(word)) return false;
  const core = word.replace(/["\u201D\u2019')\]]+$/u, "");
  if (/[?!\u061F]$/u.test(core)) return true;                        // ? and ! always end a sentence
  const rawBare = core.replace(/[.\u2026]+$/u, "");
  const bare = rawBare.toLowerCase();
  if (/^\p{Lu}$/u.test(rawBare)) return false;                       // an initial: "J."
  if (ABBREVIATIONS.has(bare) || /^(\p{L}\.)+\p{L}$/u.test(bare)) return false; // "Dr.", "e.g.", "U.S."
  // a full stop followed by a lowercase word is not a sentence end ("approx. five", "so... then")
  if (next && /^\p{Ll}/u.test(next.replace(/^["\u201C\u2018('\[]+/u, ""))) return false;
  return true;
}

/**
 * Re-cut transcription segments into whole sentences.
 * Whisper cuts its output at timestamps, which often falls mid-sentence. This joins the pieces and
 * splits again at sentence ends, estimating each sentence's time from its position inside its segment.
 * chunks: [{ start, end, text }] -> [{ start, end, text }]
 */
export function reflowSentences(chunks, { maxWords = 70 } = {}) {
  const words = [];
  chunks.forEach((c, ci) => {
    const text = String(c.text || "").trim();
    if (!text) return;
    const start = Number(c.start) || 0;
    const end = Number.isFinite(c.end) && c.end > start ? c.end : start + 2;
    const dur = end - start;
    const parts = text.split(/\s+/);
    const total = text.length || 1;
    let pos = 0;
    for (const w of parts) {
      words.push({ w, ci, t0: start + (pos / total) * dur, t1: start + ((pos + w.length) / total) * dur });
      pos += w.length + 1;
    }
  });

  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].t0, end: Math.max(cur[0].t0, cur[cur.length - 1].t1), text: cur.map((x) => x.w).join(" ") });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const wd = words[i];
    // Output with no punctuation at all: fall back to the transcription's own cut points.
    if (cur.length >= maxWords && cur[cur.length - 1].ci !== wd.ci) flush();
    cur.push(wd);
    if (endsSentence(wd.w, words[i + 1]?.w)) flush();
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ */
/* Turns and export formats                                           */
/* ------------------------------------------------------------------ */

/**
 * Merge consecutive lines into turns.
 * Lines from the same speaker become one turn. Lines with no speaker are grouped into paragraphs
 * (a new paragraph starts after a pause of 1.5 s or once it gets long), so the text still flows.
 * items: [{ start, end, speaker, text }], labels: { mod, stk }
 */
export function toTurns(items, labels, { pauseSeconds = 1.5, maxChars = 600 } = {}) {
  const turns = [];
  for (const it of items) {
    const text = (it.text || "").trim();
    if (!text) continue;
    const prev = turns[turns.length - 1];
    const sameSpeaker = prev && it.speaker && prev.speaker === it.speaker;
    const sameParagraph = prev && !it.speaker && !prev.speaker
      && it.start - prev.end < pauseSeconds && prev.text.length < maxChars;
    if (sameSpeaker || sameParagraph) {
      prev.text += " " + text;
      prev.end = it.end;
    } else {
      turns.push({
        start: it.start, end: it.end, speaker: it.speaker || null,
        label: it.speaker ? labels[it.speaker] : null, text,
      });
    }
  }
  return turns;
}

export function buildPlain(turns, { timestamps = false, header = [] } = {}) {
  const lines = turns.map((t) => `${timestamps ? `[${stamp(t.start)}] ` : ""}${t.label ? `${t.label}: ` : ""}${t.text}`);
  const head = header.length ? header.join("\n") + "\n\n" : "";
  return head + lines.join("\n\n");
}

export function buildSrt(items, labels) {
  const rows = items.filter((it) => (it.text || "").trim());
  return rows.map((it, i) => {
    const who = it.speaker ? `${labels[it.speaker]}: ` : "";
    const end = it.end > it.start ? it.end : it.start + 2;
    return `${i + 1}\n${stamp(it.start, ",")} --> ${stamp(end, ",")}\n${who}${it.text.trim()}\n`;
  }).join("\n");
}

export function buildVtt(items, labels) {
  const rows = items.filter((it) => (it.text || "").trim());
  const body = rows.map((it) => {
    const who = it.speaker ? `${labels[it.speaker]}: ` : "";
    const end = it.end > it.start ? it.end : it.start + 2;
    return `${stamp(it.start, ".")} --> ${stamp(end, ".")}\n${who}${it.text.trim()}\n`;
  }).join("\n");
  return "WEBVTT\n\n" + body;
}

/** UTF-8 CSV with a byte-order mark so Excel shows Arabic and French correctly. */
export function buildCsv(turns) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\s*[\r\n]+\s*/g, " ")}"`;
  const head = ["start", "end", "speaker", "text"].map(q).join(",");
  const rows = turns.map((t) => [stamp(t.start), stamp(t.end), t.label || "", t.text].map(q).join(","));
  return "\uFEFF" + [head, ...rows].join("\r\n") + "\r\n";
}

# Private audio transcriber

Browser-based speech-to-text that runs on the visitor's own computer. Audio is never uploaded. Hosted for free on GitHub Pages.

## What it does

- Whisper speech models (tiny, base, small) via transformers.js. English, French, Arabic and about ten more languages, plus translate-to-English.
- Live preview while it works, a window counter with time remaining, and a Cancel button.
- **Clean-up:** removes filler sounds (um, uh, er, hmm, euh, ...), with options for mm-hmm / uh-huh, repeated words, and your own list of words and phrases.
- **Glossary:** `heard => correct` fixes for drug names, disease terms and other vocabulary.
- **Whole sentences:** the transcript is re-cut into complete sentences (Whisper's own cut points often fall mid-sentence), and same-speaker sentences read as flowing paragraphs.
- **Automatic speaker tags:** Moderator and Stakeholder are identified from the voices in the audio, with no extra model download. You can rename the labels, swap them, and fix any line with the keyboard.
- **Edit** any line, and click a timestamp to hear that moment.
- **Export:** Word (.docx) laid out as an interview transcript (optional header lines such as "Stakeholder Code: KSA01_1", then "Moderator: ..." and "Stakeholder: ..." paragraphs), Excel-friendly CSV, PDF, .txt, .srt, .vtt, and a session file you can reopen later. Timestamps are optional and off by default.

## Deploy

### Option A: quickest

1. Create a GitHub repo and upload `index.html`, `worker.js`, `textutils.js`, `docx.js` and `diarize.js` to the root.
2. **Settings → Pages → Source: Deploy from a branch**, pick `main` and `/ (root)`.

The page then loads the speech library from jsDelivr and the models from Hugging Face.

### Option B: self-contained (recommended)

Your own Pages site serves the library and the models, so visitors need nothing external.

1. Upload **everything** in this folder, including `.github/workflows/deploy.yml` and `scripts/`.
2. **Settings → Pages → Source: GitHub Actions**.
3. **Actions → Deploy to GitHub Pages → Run workflow** (it also runs on every push to `main`).

The workflow downloads the models (about 370 MB in total) at build time; they are not stored in your repo. If the deploy complains about size, delete `small` from the `fetch_models.py` line in the workflow.

### Updating the site

Browsers cache files for a few minutes. When you change any file, also change the number in `APP_VERSION` and in the `?v=` import lines in `index.html`, `worker.js` and `docx.js`. Visitors then get the new files straight away.

## Using the transcript

**Clean-up.** On by default for filler sounds. Fillers are matched by language, so choose the language instead of "Detect automatically" when you can: for example "um" is a real word in Portuguese and German and is left alone there. Acronyms and units are protected ("ER", "5 mm", "mmHg", "err on the side of caution"). Anything you type into a line is kept exactly as you wrote it. The original wording is never lost: turn the option off to see it again.

**Speakers.** With "Tag speakers automatically" ticked, roles are set as soon as the transcript is ready. To redo it later (or for a saved session), choose the audio file again and press **Detect speakers from audio**. A note under the buttons says how clearly the two voices differed. If Moderator and Stakeholder come out reversed, press **Swap roles**. To fix a single line, click its role tag, or tab to it and press **M** (moderator), **S** (stakeholder) or **0** (clear); the arrow keys move between lines. **Guess from questions only** is a rougher fallback that does not use the audio.

**Paragraph view** shows the transcript exactly as the Word export will read: one paragraph per turn.

**Exports.** Consecutive lines from the same speaker are merged into one turn in the Word, CSV, PDF and .txt exports. PDF uses your browser's print dialog: choose "Save as PDF". The CSV has a byte-order mark so Excel shows Arabic and French correctly.

**Sessions.** *Save session* writes a .json file with the transcript, your edits and the roles. *Open saved session* brings it back; choose the same audio file again to restore playback. Session files contain the full transcript text, so treat them as confidential. A copy is also kept in the browser tab as a safety net against accidental reloads; it is wiped when the tab is closed.

## Run it on your own computer, offline

```bash
pip install huggingface_hub
python scripts/fetch_models.py --out models tiny base small
bash scripts/vendor.sh vendor
python -m http.server 8000
# open http://localhost:8000
```

## If you see "Failed to fetch"

Press **Check my setup**. If the Hugging Face or jsDelivr rows fail, your network is blocking them: use Option B. If "model on this site" has a tick, self-hosting works.

## How it works

1. The Web Audio API decodes the file to 16 kHz mono.
2. A Web Worker runs Whisper (WebGPU when available, otherwise 8-bit WASM on the CPU) on 30-second windows with 5 seconds of overlap, then stitches them together with timestamps.
3. The text is re-cut into whole sentences (`textutils.js`).
4. Speaker detection (`diarize.js`) measures each burst of speech (spectral shape and pitch), splits them into two voices, smooths out flicker using the pauses, hands the result to the sentences, and decides which voice is the moderator from the text (who asks the questions, who talks less, who speaks first).
5. Everything after that (clean-up, glossary, exports) is plain text processing, with the Word writer in `docx.js`. No network access is involved.

## Limits

- **Speaker detection is an estimate.** It was tested on synthetic two-voice interviews (88 to 98 percent of sentences correct with distinct voices, including through noise and MP3 compression, and it flags low confidence when the voices are alike), not yet on real recordings. Expect most errors on very short sentences such as "Okay." at the start of a turn, on overlapping speech, and when both people sound alike or a third person joins. It assumes exactly two speakers. If your platform can save a separate audio track per participant (Zoom can), labelling can be exact instead of estimated.
- **CPU speed.** Plain GitHub Pages cannot send the headers that allow multi-threaded WASM, so CPU mode is single-threaded. Optional: add `coi-serviceworker.js` (MIT licence) next to `index.html` and uncomment the script tag at the bottom of `index.html`.
- **Long files.** A one-hour recording needs several hundred MB of memory after decoding. For much longer recordings, split them first.
- **Accuracy.** Use Accurate (small) for Arabic, Urdu, Hindi and Tamil, and for technical vocabulary. Always review before delivering to a client.

## Licences

Whisper (OpenAI) is MIT. transformers.js is Apache-2.0. ONNX Runtime is MIT. Check the model card of each Xenova or onnx-community conversion for its licence terms.

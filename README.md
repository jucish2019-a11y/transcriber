# Private audio transcriber

Browser-based speech-to-text that runs entirely on the visitor's own computer. Audio is never uploaded. Hosted for free on GitHub Pages.

- Whisper speech models (tiny, base, small) via transformers.js and ONNX Runtime
- English, French, Arabic and about ten more languages, plus translate-to-English
- Live preview while it works, progress with time remaining, cancel any time
- Edit the transcript, click a timestamp to jump the audio, export .txt, .srt, .vtt
- Built-in "Check my setup" that shows which download is being blocked

## Option A: quickest (2 minutes)

1. Create a GitHub repo and upload `index.html` and `worker.js` to the root.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` and `/ (root)`.
3. Open `https://<your-username>.github.io/<repo>/`.

In this mode the page loads the speech library from jsDelivr and the models from Hugging Face. It works for anyone whose network can reach those two sites.

## Option B: self-contained (recommended)

Your own GitHub Pages serves the library and the models, so visitors need nothing external. This also fixes "Failed to fetch" on networks that block Hugging Face.

1. Upload **everything** in this folder to the repo, including `.github/workflows/deploy.yml` and `scripts/`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Open the **Actions** tab, run **Deploy to GitHub Pages** (it also runs on every push to `main`).

The workflow downloads the three models (about 370 MB in total) and the library at build time. They are not stored in your repo. If the deploy complains about file or site size, delete `small` from the `fetch_models.py` line in the workflow.

## Run it on your own computer, offline

The page needs a web server because browsers block workers on `file://` addresses.

```bash
pip install huggingface_hub
python scripts/fetch_models.py --out models tiny base small
bash scripts/vendor.sh vendor
python -m http.server 8000
# open http://localhost:8000
```

After the first run everything works without internet.

## If you see "Failed to fetch"

Press **Check my setup**. It tests, from your browser, whether the library and model files can be reached:

| Result | Meaning | Fix |
|---|---|---|
| Hugging Face rows fail | Network, VPN, firewall or extension blocks huggingface.co or its storage host | Use Option B |
| jsDelivr row fails | CDN blocked | Use Option B |
| "model on this site" is ✓ | Self-hosting works | Nothing to do |
| Everything ✓ but it still fails | Likely memory or a browser bug | Try the Fast model, a shorter file, or another browser; note the exact error text |

## How it works

The design follows the popular open-source browser transcribers (Xenova's whisper-web and its maintained forks):

1. **Decode on the main thread.** The Web Audio API turns MP3/WAV/M4A/MP4 into 16 kHz mono samples.
2. **Transcribe in a Web Worker.** The page never freezes, and Cancel simply ends the worker.
3. **Sliding windows.** Audio is cut into 30-second windows with 5 seconds of overlap, decoded greedily, then stitched back together with timestamps.
4. **Streaming.** A Whisper text streamer reports tokens as they are generated, which drives the live preview and the progress count.
5. **Two engines.** WebGPU (fast) when the browser has it, otherwise 8-bit quantized WASM on the CPU, which runs on any laptop.
6. **Cached after first use.** Models are stored in the browser cache; "Remove downloaded models" clears them.

## Limits and upgrades

- **CPU speed.** Plain GitHub Pages cannot send the headers that allow multi-threaded WASM, so CPU mode is single-threaded. To enable several threads, download `coi-serviceworker.js` (MIT licence, search for "coi-serviceworker"), put it next to `index.html`, and uncomment the script tag near the bottom of `index.html`. The page reloads once. If anything misbehaves, remove the tag.
- **Long files.** A one-hour recording needs several hundred MB of memory after decoding. For recordings much longer than that, split them first.
- **Accuracy.** Use Accurate (small) for Arabic, Urdu, Hindi and Tamil. Tiny and Base are noticeably weaker there.
- **No speaker labels.** Whisper does not separate speakers.
- **Confidential recordings.** Nothing leaves the device, but your own copy of this site should be what people use, so you control the code.

## Licences

Whisper (OpenAI) is MIT. transformers.js is Apache-2.0. ONNX Runtime is MIT. Check the model card of each Xenova or onnx-community conversion for its licence terms.

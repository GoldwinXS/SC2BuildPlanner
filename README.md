# SC2 Timings

Threat-centric build/timing reference for StarCraft II — a single-page browser app that simulates economy, production, and tech requirements so you can answer questions like *"when can a Dark Templar realistically arrive?"* or *"what could my opponent have at 5:30?"*

No build step, no server, no dependencies. Just open `index.html`.

## Features

- **Tech Explorer** — pick any unit, building, or upgrade and get the earliest realistic time it can be ready, including a full production-aware simulation (workers, gas, supply, Pylon power, chrono boost).
- **Build Forge** — compose a build order step-by-step. The simulator runs your exact list and reports when each action lands, what blocks it, and where idle time appears. Includes preset openers, drag-drop reordering, addon-swap support, and a worker-fill helper.
- **Build Library** — save, name, organize, and export builds locally. Each browser keeps its own library in `localStorage`.
- **Replay import** — drop in a `.SC2Replay` file and the app extracts each player's build order from the in-game tracker stream. Pure-JS MPQ + bzip2 + s2protocol decode in the browser, no upload anywhere. Detects building morphs (Orbital Command, Lair, Hive…) and Terran addon swaps. Adjustable capture window per replay.
- **Scout Translator** — enter what you scouted and the tool overrides the natural timeline to compute the earliest each downstream threat can arrive.
- **Window Lookup** — pick a race and a time, get everything that race could have by then.
- **Reference tables** — every value the calculators read from, editable in `data.js`.

## Hosting on GitHub Pages

This app is a plain static site, so hosting is one click:

1. Create a new GitHub repo and push these files to `main`.
2. In the repo, go to **Settings → Pages**.
3. Under *Build and deployment*, set **Source** to *Deploy from a branch*, **Branch** to `main`, **Folder** to `/ (root)`.
4. Save. After ~30 seconds your site will be live at `https://<your-username>.github.io/<repo-name>/`.

The included `.nojekyll` file disables Jekyll processing so files are served as-is.

## Running locally

Open `index.html` directly in a modern browser, or serve the folder for cleaner relative-URL behaviour:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000/
```

Tested on recent Chrome, Safari, and Firefox. The replay parser uses the browser-native `DecompressionStream` API (Safari 16.4+, Chrome 80+, Firefox 113+).

## Project layout

```
index.html       — markup + script tags
styles.css       — all styling (dark theme, race-coded accents)
data.js          — every unit/building/upgrade definition (edit for new patches)
simulator.js    — production / economy / tech-tree simulator
replay.js        — MPQ archive reader, bzip2 decoder, s2protocol VersionedDecoder
app.js           — UI, build library, replay → build-order synthesis
icons/           — unit, building, and upgrade portraits
```

To update for a new SC2 patch: edit values in `data.js`. The calculators read from it on load.

## Replay support

Replays are decoded entirely in the browser:

- **MPQ archive** — header, hash table, block table, multi-sector & single-unit decompression.
- **Compression** — zlib via `DecompressionStream`, bzip2 via a vendored pure-JS decoder (BWT + MTF + Huffman + RLE).
- **VersionedDecoder** — Blizzard's byte-aligned self-describing format used by `replay.details` and `replay.tracker.events`.
- **Synthesis** — maps in-game unit/building/upgrade names to the app's entity IDs, filters cosmetic upgrades and neutral map units, detects addon swaps via paired Lift/Land events, and emits an editable build order.

Anything decoder-related lives in `replay.js`; the entity-name mapping lives at the top of the *Replay → build-order synthesis* section in `app.js`. Adding a new unit/upgrade to the map is a one-line edit.

## License

MIT — see `LICENSE`.

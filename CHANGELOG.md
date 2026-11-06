# Changelog

All notable changes to Schematic Net Tracer. The version lives in `extension/manifest.json`; `node scripts/version.mjs X.Y.Z` bumps it everywhere. Every version merged to `main` is tagged and released automatically, with the section below as release notes.

## [0.8.0] — 2026-11-06

Measured on the 30-file corpus of real schematics (pin pairs of the 11 files with an Eagle/KiCad netlist, pooled):
precision 0.33 → 0.85, recall 0.24 → 0.33, F1 0.27 → 0.47; nets named after two different rails 11 files → 0;
slowest page 10.3 s → 1.5 s.

### Fixed
- One wire never shows two rails (GND and +3V3, 5V and 3V3): the less reliable label is dropped, on the page and across pages.
- Power-symbol names attach only near where the symbol touches the wire, so a GND under an LED or a resistor drawn without a wire no longer names the other side.
- Notes repeated next to neighbouring pins (Arduino's “pwm”) no longer glue those pins into one net.
- Pin numbers sit above their pin line: a number is no longer given to the pin below it.
- BGA ball numbers next to pins (J2, AB12) are pin numbers, not part names; the real reference (U1) is found, and usual designator letters are preferred over names like A20.
- Rotated texts side by side (a column of pin names) are no longer glued into one text.
- Altium Smart PDF: hidden cross-probe tags (PIU…, CO…, NL…) are ignored, and the “Components” bookmarks are no longer read as nets (they merged every net of a chip).
- Values written with the Greek μ (4.7μF) are values, not net labels.
- White-filled circles are symbols, not junction dots; circles drawn as polygons count as power-symbol heads.

### Added
- Ground symbols drawn without a name (a stem ending in bars, pointing down) join the ground net — Olimex schematics draw every ground this way.

### Performance
- Text drawn as thin filled rectangles (Eagle vector font) is read once instead of twice; faster spatial index and connectivity loop. PocketBeagle: 10 s → 0.8 s per page.

### Benchmark
- Pooled precision / recall / F1 over all pin pairs; rail shorts counted against the netlists (two power nets of the netlist inside one detected net), not against our own names.

## [0.7.0] — 2026-11-06

### Changed
- Code split into pure modules under `extension/js/core/` (geometry, extraction, connectivity, document model, search, export, pipeline); the UI in `viewer.js` only renders and handles input.
- PDF parsing runs in a Web Worker (`analyze.worker.js`), so large multi-page manuals no longer freeze the page; it falls back to the main thread if workers are unavailable. Net rebuilding after a settings change yields between pages.

### Added
- Unit tests (`npm test`, Node test runner): geometry, connectivity rules, labels, power names, CSV, and the sample PDFs through the real pdf.js pipeline.
- End-to-end tests (`npm run test:e2e`, Playwright): web viewer, phone layout, and the unpacked Chrome extension.
- Benchmark on a corpus of real open-hardware schematics (`npm run corpus`, `npm run bench`).
- CI on every push and pull request; automatic tag and GitHub release whenever the manifest version changes.

### Accuracy (measured on the 30-file corpus)
- T-junctions without a dot no longer connect on sheets that draw junction dots (“T-join needs a dot” is now *auto*), which removed most made-up GND↔VCC shorts on Eagle sheets.
- The default wire class is picked per page from the junction dots, not from the longest lines.
- Text drawn as strokes (vector fonts) is no longer mistaken for wires.
- Labels attach by distance to the wire segment, not just to line ends; labels crossing a wire or sitting on its side are penalised.
- Nets merge only by their most reliable label, and not when two different names are equally close.
- Section frames that contain wires are not taken for component bodies; Eagle bodies drawn as four lines are recognised.
- Pin and ball numbers next to pins are no longer listed as parts.
- Benchmark: mean F1 0 → 0.31 on files with a ground-truth netlist; best file (KiCad, Olimex ESP32-PoE) 0.84.

## [0.6.0] — 2026-11-02

### Added
- Phone and tablet layout: bottom sheet with drag handle, larger touch targets, tap chooser when several wires are under the finger.
- Installable PWA for the web version: offline after the first visit, Android “Share → Net Tracer” target for PDFs.

## [0.5.0] — 2026-11-02

### Added
- GitHub Pages site: landing page, online viewer at `/app/`, privacy policy.

## [0.4.0] — 2026-11-02

### Added
- Tabs for nets, parts, search results and settings; power/signal net types and label counts.
- Label stepping (◀ ▶) across pages, page dots for the selected net.
- Parts list with values, multi-unit grouping, jump to part.
- Search across all text with markers and ranking; CSV export of nodes and parts.
- Analysis of every page of multi-page PDFs; same-name labels merged across sheets; Altium Smart-PDF bookmark netlists.
- Dim-the-rest, pan by dragging, pinch zoom, keyboard navigation.

## [0.3.0] — 2026-11-02

### Added
- English interface by default with a Russian switch; localised store listing.
- README with screenshots, samples, MIT licence, release workflow.

## [0.2.0] — 2026-11-02

### Added
- First public version: Chrome extension that opens `.pdf` links in the viewer, highlights the net under the cursor, lists pins and labels, shows dangling ends; wire/graphics classification by colour and line width.

// Schematic Net Tracer — analysis worker.
// Runs pdf.js and the geometry extraction off the main thread, so a 50-page manual does not freeze the UI.
// pdf.js normally spawns its own worker; here we hand it the worker module directly ("fake worker"),
// so parsing happens in this thread. Messages:
//   in:  {id, data:ArrayBuffer}
//   out: {id, type:'meta', numPages} · {id, type:'page', p, raw} · {id, type:'done', outline} · {id, type:'error', name, message}
import * as pdfjs from '../lib/pdf.min.mjs';
import * as pdfjsWorker from '../lib/pdf.worker.min.mjs';
import { extractPage, readOutline } from './core/extract.js';
globalThis.pdfjsWorker = pdfjsWorker;

self.onmessage = async (e) => {
  const { id, data } = e.data;
  let doc = null;
  try {
    doc = await pdfjs.getDocument({ data, disableFontFace: true, isEvalSupported: false, isOffscreenCanvasSupported: false }).promise;
    self.postMessage({ id, type: 'meta', numPages: doc.numPages });
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const raw = await extractPage(page, pdfjs.OPS);
      page.cleanup();
      self.postMessage({ id, type: 'page', p, raw });
    }
    self.postMessage({ id, type: 'done', outline: await readOutline(doc) });
  } catch (err) {
    self.postMessage({ id, type: 'error', name: err && err.name, message: String(err && err.message || err) });
  } finally {
    if (doc) try { await doc.destroy(); } catch {}
  }
};

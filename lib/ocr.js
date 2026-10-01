// OCR for image-only PDFs (scans, or CVs exported as a picture). Runs on the
// server with Tesseract so the CV text can still be redacted before any of it
// reaches the LLM. Images are pulled straight out of the PDF (no rendering, so
// no native canvas dependency), converted to PNG and recognised.

const os = require('os');
const { PNG } = require('pngjs');

const MAX_PAGES = 3;
const MIN_SIDE = 300; // ignore logos, icons and other small images

// pdf.js image kinds: 1 = 1-bit grayscale, 2 = RGB 24-bit, 3 = RGBA 32-bit.
function toPng({ width, height, data, kind }) {
  const png = new PNG({ width, height });
  const out = png.data;
  if (kind === 3) {
    out.set(data.subarray(0, width * height * 4));
  } else if (kind === 2) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255;
    }
  } else if (kind === 1) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const k = (y * width + x) * 4;
        out[k] = out[k + 1] = out[k + 2] = v; out[k + 3] = 255;
      }
    }
  } else {
    return null;
  }
  return PNG.sync.write(png);
}

function getObj(page, id) {
  return new Promise(resolve => {
    const store = id.startsWith('g_') ? page.commonObjs : page.objs;
    try { store.get(id, resolve); } catch { resolve(null); }
    setTimeout(() => resolve(null), 5000);
  });
}

// Returns PNG buffers for the large images on each page, in reading order.
async function pageImages(doc, OPS) {
  const pngs = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
    const page = await doc.getPage(n);
    const ops = await page.getOperatorList();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== OPS.paintImageXObject) continue;
      const img = await getObj(page, ops.argsArray[i][0]);
      if (!img || !img.data || Math.min(img.width, img.height) < MIN_SIDE) continue;
      const png = toPng(img);
      if (png) pngs.push(png);
    }
  }
  return pngs;
}

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    // Language data downloads once and is cached in the temp dir (writable on Vercel).
    workerPromise = createWorker('eng', 1, { cachePath: os.tmpdir() }).catch(err => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function recognize(pngs) {
  if (!pngs.length) return '';
  const worker = await getWorker();
  const parts = [];
  for (const png of pngs) {
    const { data } = await worker.recognize(png);
    parts.push(data.text);
  }
  return parts.join('\n\n');
}

// pdf.js canvas factory backed by @napi-rs/canvas (prebuilt, no native build).
class NapiCanvasFactory {
  constructor() { this.createCanvas = require('@napi-rs/canvas').createCanvas; }
  create(width, height) {
    const canvas = this.createCanvas(Math.max(1, width), Math.max(1, height));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc, width, height) { cc.canvas.width = width; cc.canvas.height = height; }
  destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
}

// Renders each page to an image. Covers PDFs whose text is drawn with broken
// fonts (no letter mapping) or as vector shapes, where there is no image to pull out.
async function renderPages(buffer, pdfjs) {
  const factory = new NapiCanvasFactory();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false, canvasFactory: factory }).promise;
  try {
    const pngs = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 2.5 });
      const cc = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      cc.context.fillStyle = '#ffffff';
      cc.context.fillRect(0, 0, cc.canvas.width, cc.canvas.height);
      await page.render({ canvasContext: cc.context, viewport }).promise;
      pngs.push(cc.canvas.toBuffer('image/png'));
      factory.destroy(cc);
    }
    return pngs;
  } finally {
    await doc.destroy();
  }
}

const letters = s => s.replace(/\s+/g, '').length;

// OCR an image-only or unreadable PDF: first the embedded images (fast, full
// resolution), then, if that finds little, a rendered picture of each page.
async function ocrPdf(doc, pdfjs, buffer, minChars) {
  let best = await recognize(await pageImages(doc, pdfjs.OPS));
  if (letters(best) < minChars && buffer) {
    try {
      const rendered = await recognize(await renderPages(buffer, pdfjs));
      if (letters(rendered) > letters(best)) best = rendered;
    } catch (err) {
      console.error('Page rendering for OCR failed:', err.message);
    }
  }
  return best;
}

module.exports = { ocrPdf };

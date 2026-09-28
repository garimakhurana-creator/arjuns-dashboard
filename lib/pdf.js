// PDF -> plain text using Mozilla's pdf.js. It tolerates PDFs with damaged
// cross-reference tables (common in generated CVs) that stricter parsers
// reject or misread. Items are joined line by line using their y-position.

let pdfjs = null;
async function load() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

async function pdfToText(buffer) {
  const { getDocument } = await load();
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const { items } = await (await doc.getPage(i)).getTextContent();
      let text = '';
      let lastY = null;
      for (const it of items) {
        const y = it.transform ? it.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n';
        else if (text && !text.endsWith(' ') && it.str && !it.str.startsWith(' ')) text += ' ';
        text += it.str;
        if (it.hasEOL) text += '\n';
        lastY = y;
      }
      pages.push(text);
    }
    return pages.join('\n\n');
  } finally {
    await doc.destroy();
  }
}

module.exports = { pdfToText };

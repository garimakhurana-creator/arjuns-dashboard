// Word (.docx) -> plain text. The applications folder is "mixed formats",
// and Kargo's past-hire profiles are .docx.

const mammoth = require('mammoth');

async function docxToText(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

module.exports = { docxToText };

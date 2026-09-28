// Pulls contact PII out of raw CV text and returns a redacted copy. Only the
// redacted text is ever sent to the LLM; name/email/phone stay server-side and
// are merged back into the record (and email drafts) after evaluation.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{4,5}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin\.com|github\.com)\/\S+/gi;

// Words that mark a line as a section heading, job title, place or school,
// never a person's name. Without this, "Professional Summary" or "Associate
// Product Manager" would be taken as the name and scrubbed from the whole CV.
const NOT_A_NAME = /\b(summary|profile|objective|experience|work|skills?|core|competencies|education|projects?|certifications?|achievements?|professional|synopsis|contact|about|product|manager|management|lead|leader|head|director|associate|senior|strategy|strategic|operations|marketing|analyst|engineer|consultant|founder|ai|college|university|institute|school|engineering|technology|technical|science|bachelor|master|degree|mba|and|of|the|india|bangalore|bengaluru|mumbai|pune|delhi|chennai|hyderabad|kolkata|resume|curriculum|vitae)\b/i;

// "07_aditya_nair.pdf", "spm_16_siddharth_rao.pdf", "Priya-Sharma CV.pdf" -> name
function nameFromFilename(filename) {
  if (!filename) return null;
  const words = filename
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[_\-\s.]+/)
    .filter(w => w && !/^\d+$/.test(w) && !/^(s?pm|cv|resume|final|updated|new|v\d+)$/i.test(w));
  if (words.length < 2 || words.length > 4 || !words.every(w => /^[a-z']+$/i.test(w))) return null;
  return words.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function guessName(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 8);
  for (const line of lines) {
    if (/[@\d|:/]/.test(line) || NOT_A_NAME.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (words.every(w => /^[A-Z][a-zA-Z.'-]+$/.test(w) || /^[A-Z.'-]+$/.test(w))) {
      // "Shrey Marathe Shrey Marathe" (name repeated in a header) -> "Shrey Marathe"
      const half = words.length / 2;
      const deduped = words.length === 4 && words.slice(0, half).join(' ').toLowerCase() === words.slice(half).join(' ').toLowerCase()
        ? words.slice(0, half) : words;
      return deduped.map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    }
  }
  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Name precedence: typed override > detected in CV > derived from filename.
function extractAndRedact(rawText, overrides = {}) {
  const emails = rawText.match(EMAIL_RE) || [];
  const name = (overrides.name || '').trim() || guessName(rawText) || nameFromFilename(overrides.filename);
  const email = (overrides.email || '').trim() || emails[0] || null;
  const phones = (rawText.match(PHONE_RE) || []).filter(p => p.replace(/\D/g, '').length >= 10);

  let redacted = rawText
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(URL_RE, '[URL]');
  for (const p of phones) redacted = redacted.split(p).join('[PHONE]');

  if (name) {
    for (const part of name.split(/\s+/).filter(w => w.length >= 3)) {
      redacted = redacted.replace(new RegExp(`\\b${escapeRe(part)}\\b`, 'gi'), '[CANDIDATE]');
    }
  }

  return {
    pii: { name: name || 'Candidate', email, phone: phones[0] || null },
    redactedText: redacted,
  };
}

module.exports = { extractAndRedact, nameFromFilename };

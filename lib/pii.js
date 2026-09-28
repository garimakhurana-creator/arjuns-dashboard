// Pulls contact PII out of raw CV text and returns a redacted copy. Only the
// redacted text is ever sent to the LLM; name/email/phone stay server-side and
// are merged back into the record (and email drafts) after evaluation.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{4,5}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin\.com|github\.com)\/\S+/gi;

function guessName(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 8);
  for (const line of lines) {
    if (/[@\d|:/]/.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (words.every(w => /^[A-Z][a-zA-Z.'-]+$/.test(w) || /^[A-Z.'-]+$/.test(w))) {
      return words.map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    }
  }
  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAndRedact(rawText, overrides = {}) {
  const emails = rawText.match(EMAIL_RE) || [];
  const name = (overrides.name || '').trim() || guessName(rawText);
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

module.exports = { extractAndRedact };

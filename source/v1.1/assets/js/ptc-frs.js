/* ptc-frs.js — BETA-01
 * file-reference-sha256-v1 (FRS-01) y disclosure-notice-v1 (DCL-03).
 * No modifica ptc-core.js: reutiliza normalizeText/computeHashDoc/
 * computeHashPTC/computeEthicalContextHash/serializePTC tal cual existen.
 * FRS-01 trata la fuente como una secuencia opaca de bytes: no la
 * interpreta, no la descomprime, no la abre.
 */
const PTCFileReference = (() => {

  // ── SHA-256 de los bytes exactos de un archivo ──────────────────────────
  async function computeSourceSha256(file) {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── Descriptor FRS-01 — gramática exacta, byte a byte ───────────────────
  // "PTC FILE REFERENCE" es literal obligatorio (§10.2 de FRS-01 v0.3).
  // size_bytes: decimal ASCII puro, sin separadores, sin ceros iniciales.
  // source_sha256: 64 caracteres hexadecimales en minúsculas.
  function buildFileReferenceBlock(sizeBytes, sourceSha256) {
    if (!/^[0-9a-f]{64}$/.test(sourceSha256)) {
      throw new Error('source_sha256 no tiene el formato exigido por FRS-01 (64 hex minúsculas).');
    }
    return (
      'PTC FILE REFERENCE\n' +
      'profile: file-reference-sha256-v1\n' +
      `size_bytes: ${sizeBytes}\n` +
      `source_sha256: ${sourceSha256}\n`
    );
  }

  // ── Bloque DCL-03 — gramática exacta ─────────────────────────────────────
  const DCL_KNOWN_TYPES = ['ai_generated', 'ai_modified', 'ai_generated_or_modified'];
  const DCL_KNOWN_LANGS = ['es', 'en', 'fr'];

  function buildDisclosureBlock(type, language, verificationUrl) {
    if (!DCL_KNOWN_TYPES.includes(type)) throw new Error('type de divulgación no reconocido.');
    if (!DCL_KNOWN_LANGS.includes(language)) throw new Error('language de divulgación no soportado en esta versión.');
    let block =
      'PTC DISCLOSURE\n' +
      'profile: disclosure-notice-v1\n' +
      `type: ${type}\n` +
      `language: ${language}\n`;
    if (verificationUrl) block += `verification_url: ${verificationUrl}\n`;
    return block;
  }

  // ── Composición del objeto canónico completo (FRS-01 [+ DCL-03]) ────────
  // Regla de composición (Decisiones v0.4 / FRS-01 v0.3 §19-23): el bloque
  // de archivo es obligatorio y va primero; el de divulgación es opcional,
  // aparece una sola vez, y entre ambos hay EXACTAMENTE una línea vacía.
  // normalizeText() se aplica al conjunto, nunca por separado a cada bloque.
  function buildCanonicalObject({ sizeBytes, sourceSha256, disclosure }) {
    let raw = buildFileReferenceBlock(sizeBytes, sourceSha256);
    if (disclosure) {
      raw = raw.replace(/\n$/, '') + '\n\n' + buildDisclosureBlock(
        disclosure.type, disclosure.language, disclosure.verificationUrl
      );
    }
    return PTCCore.normalizeText(raw);
  }

  // ── Derivación determinista de notice.txt (DCL-03 §20-21) ───────────────
  const NOTICE_TITLES = {
    es: 'AVISO PÚBLICO SOBRE EL USO DE IA',
    en: 'PUBLIC NOTICE ON THE USE OF AI',
    fr: "AVIS PUBLIC SUR L'UTILISATION DE L'IA",
  };
  const NOTICE_URL_LABELS = { es: 'Verificación', en: 'Verification', fr: 'Vérification' };
  const NOTICE_BODIES = {
    es: {
      ai_generated: 'Este contenido ha sido generado con inteligencia artificial.',
      ai_modified: 'Este contenido ha sido modificado con inteligencia artificial.',
      ai_generated_or_modified: 'Este contenido ha sido generado o modificado con inteligencia artificial.',
    },
    en: {
      ai_generated: 'This content was generated with artificial intelligence.',
      ai_modified: 'This content was modified with artificial intelligence.',
      ai_generated_or_modified: 'This content was generated or modified with artificial intelligence.',
    },
    fr: {
      ai_generated: "Ce contenu a été généré à l'aide de l'intelligence artificielle.",
      ai_modified: "Ce contenu a été modifié à l'aide de l'intelligence artificielle.",
      ai_generated_or_modified: "Ce contenu a été généré ou modifié à l'aide de l'intelligence artificielle.",
    },
  };

  function buildNoticeText(type, language, verificationUrl) {
    const title = NOTICE_TITLES[language];
    const body = NOTICE_BODIES[language][type];
    if (verificationUrl) {
      const label = NOTICE_URL_LABELS[language];
      return `${title}\n\n${body}\n\n${label}: ${verificationUrl}\n`;
    }
    return `${title}\n\n${body}\n`;
  }

  // notice.html — presentación; no forma parte del objeto protegido.
  function buildNoticeHtml(type, language, verificationUrl) {
    const title = NOTICE_TITLES[language];
    const body = NOTICE_BODIES[language][type];
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let html = `<!doctype html>\n<html lang="${language}"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>\n<h1>${esc(title)}</h1>\n<p>${esc(body)}</p>\n`;
    if (verificationUrl) {
      const label = NOTICE_URL_LABELS[language];
      html += `<p>${esc(label)}: <a href="${esc(verificationUrl)}">${esc(verificationUrl)}</a></p>\n`;
    }
    html += '</body></html>\n';
    return html;
  }

  // notice.svg — presentación; solo texto, sin lógica ejecutable.
  function buildNoticeSvg(type, language, verificationUrl) {
    const title = NOTICE_TITLES[language];
    const body = NOTICE_BODIES[language][type];
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160" viewBox="0 0 480 160" role="img" aria-label="${esc(title)}">` +
      `<rect width="480" height="160" fill="#ffffff" stroke="#333333"/>` +
      `<text x="20" y="40" font-family="sans-serif" font-size="16" font-weight="bold">${esc(title)}</text>` +
      `<text x="20" y="70" font-family="sans-serif" font-size="13">${esc(body)}</text>` +
      `</svg>\n`;
  }

  return {
    computeSourceSha256, buildFileReferenceBlock, buildDisclosureBlock,
    buildCanonicalObject, buildNoticeText, buildNoticeHtml, buildNoticeSvg,
    DCL_KNOWN_TYPES, DCL_KNOWN_LANGS,
  };
})();

if (typeof window !== 'undefined') window.PTCFileReference = PTCFileReference;

/**
 * PTC-CORE — Núcleo único del Protocolo de Transparencia Canalista.
 *
 * Consumido exclusivamente por generate.js y validate.js.
 * Ninguno de los dos debe tener implementación propia de las
 * operaciones aquí definidas.
 *
 * Basado en: R-01 v1.1, PTC-F v1.2, ARCH v0.3
 * más las correcciones B1-B10 (extracción sobre bruto, forma canónica,
 * hash_scope↔objeto, CR en bloque PTC, fechas reales, |ético prohibido).
 */
const PTCCore = (() => {

  const FIELD_ORDER = [
    'version','level','operator','date_utc','ai_system','co_creation_mode',
    'human_review','purpose','hash_scope','hash_doc_sha256','hash_ptc_sha256',
    'hash_ethical_context_sha256','doi','orcid'
  ];
  const MULTILINE_ALLOWED = new Set(['purpose']);
  const KNOWN_SCOPES = ['document_without_ptc_normalized', 'reference_csv_url_normalized'];

  // I-03 — recorte estricto ASCII de borde (solo U+0020, U+0009).
  // NUNCA usar String.trim() nativo sobre valores normativos: elimina un
  // conjunto más amplio de caracteres Unicode (U+00A0, U+2028, U+2029,
  // U+FEFF...) que PTC-F trata como contenido semántico, no como
  // separador. Esta es la única función de recorte que el protocolo
  // reconoce, y la usan tanto el núcleo como cualquier generador conforme.
  const trimAsciiEdge = v => v.replace(/^[ \t]+|[ \t]+$/g, '');

  // ── R-01 §2 — Normalización del texto ────────────────────────────
  function normalizeText(text) {
    let out = text;
    if (out.charCodeAt(0) === 0xFEFF) out = out.slice(1);           // 2.1 BOM
    out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');          // 2.2 CRLF→LF
    out = out.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n'); // 2.3 espacios/tabs finales (D5)
    out = out.replace(/\n+$/, '') + '\n';                            // 2.4 un único LF final
    return out;
  }

  // ── R-01 §3.1 — Modo Referencia ──────────────────────────────────
  function buildReferenceBody(csv, url) {
    csv = (csv == null ? '' : String(csv));
    url = (url == null ? '' : String(url));
    // Rechazar ANTES de transformar. trim() en JS elimina también \r y \n
    // de los extremos — si se llamara antes de esta comprobación, un
    // CR/LF inicial o final desaparecería sin ser detectado nunca.
    if (/[\r\n]/.test(csv) || /[\r\n]/.test(url)) {
      throw new Error('CSV y URL no pueden contener saltos de línea.');
    }
    if (/^[ \t]|[ \t]$/.test(csv) || /^[ \t]|[ \t]$/.test(url)) {
      throw new Error('CSV y URL no pueden tener espacios o tabulaciones al principio o al final.');
    }
    if (!csv || !url) throw new Error('CSV y URL son obligatorios para el cuerpo-referencia.');
    return normalizeText('CSV: ' + csv + '\nURL: ' + url);
  }

  // ── SHA-256 genérico ──────────────────────────────────────────────
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── R-01 §4.1 — hash_doc_sha256 ──────────────────────────────────
  const computeHashDoc = (canonicalText) => sha256Hex(canonicalText);

  // ── R-01 §4.2 — hash_ptc_sha256 ──────────────────────────────────
  // Preimagen: líneas FÍSICAS del bloque (incluida la indentación de
  // continuaciones), excluyendo solo la línea hash_ptc_sha256.
  function ptcWithoutSelfHash(ptcBlock) {
    return ptcBlock.split('\n').filter(l => !l.startsWith('hash_ptc_sha256:')).join('\n');
  }
  const computeHashPTC = (ptcBlock) => sha256Hex(ptcWithoutSelfHash(ptcBlock));

  // ── R-01 §4.3 — hash_ethical_context_sha256 ──────────────────────
  // Preimagen: VALOR LÓGICO de cada campo (continuaciones desindentadas
  // y unidas por LF), no las líneas físicas. Fórmula fijada por D1.
  function computeEthicalContextHash(fields) {
    const canonicalString = [
      fields.version, fields.level, fields.operator, fields.date_utc,
      fields.ai_system, fields.co_creation_mode, fields.human_review, fields.purpose
    ].join('|');
    return sha256Hex(canonicalString);
  }

  // ── R-01 §5.2 — Extracción bottom-anchored (única implementación, D10) ──
  // ── R-01 §5.2 — Extracción bottom-anchored SOBRE TEXTO BRUTO (B1) ──
  // CRÍTICO: esta función NO recibe texto normalizado. Recibe el
  // artefacto exactamente como fue transmitido. La normalización
  // documental (normalizeText) se aplica DESPUÉS, únicamente al
  // prefijo documental — nunca al artefacto completo ni al bloque PTC.
  // Aplicar normalizeText antes de extraer permitía que espacios o
  // saltos de línea añadidos dentro o después del bloque PTC
  // desaparecieran silenciosamente antes de poder detectarlos (D-B1).
  function extractPTC(rawText) {
    // División estricta por LF real. Si el artefacto está en CRLF,
    // las líneas de delimitador contendrán un «\r» final y no
    // coincidirán con «<PTC>»/«</PTC>» exactos — lo cual es correcto:
    // un artefacto conforme se serializa siempre en LF puro. Un CRLF
    // inesperado en el artefacto completo debe fallar la extracción,
    // no normalizarse en silencio.
    const lines = rawText.split('\n');

    let closeIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] === '</PTC>') { closeIdx = i; break; }
    }
    if (closeIdx === -1) return { found: false, code: 'E_NO_CLOSE' };

    // D2a — perímetro estricto: el artefacto termina EXACTAMENTE en el
    // carácter «>» de «</PTC>». Cero tolerancia: ni un LF adicional.
    // Se comprueba sobre la posición exacta en la cadena bruta, no
    // sobre líneas ya separadas (que ocultarían LFs sobrantes al
    // volver a unirlas).
    const closeLineStart = lines.slice(0, closeIdx).join('\n').length + (closeIdx > 0 ? 1 : 0);
    const closeMarkerEnd = closeLineStart + '</PTC>'.length;
    if (closeMarkerEnd !== rawText.length) {
      return { found: false, code: 'E_TRAILING' };
    }

    let openIdx = -1;
    for (let i = closeIdx - 1; i >= 0; i--) {
      if (lines[i] === '<PTC>') { openIdx = i; break; }
    }
    if (openIdx === -1) return { found: false, code: 'E_NO_OPEN' };

    // Rechazar cualquier </PTC> adicional entre apertura y cierre
    for (let i = openIdx + 1; i < closeIdx; i++) {
      if (lines[i] === '</PTC>') return { found: false, code: 'E_AMBIGUOUS_CLOSE' };
    }

    // B6 — decisión normativa (revisada tras prueba contra el corpus real):
    // solo el último bloque bottom-anchored es normativo. Contenido previo
    // que parezca un bloque PTC (por ejemplo, un ejemplo ilustrativo dentro
    // de una especificación, como el que contiene PTC-F) NO se rechaza,
    // porque ya está protegido: forma parte del prefijo documental y
    // cualquier alteración posterior a la certificación cambia hash_doc_sha256
    // y la validación falla igualmente. Rechazarlo de más rompería el caso
    // de uso legítimo de documentar el propio formato con un ejemplo.

    const ptcLines = lines.slice(openIdx, closeIdx + 1);
    const ptcBlockRaw = ptcLines.join('\n');                        // preimagen FÍSICA — nunca normalizada (hash_ptc)
    const docTextRaw  = lines.slice(0, openIdx).join('\n') + '\n';  // prefijo documental BRUTO — se normaliza después
    return { found: true, ptcBlockRaw, docTextRaw, innerLines: lines.slice(openIdx + 1, closeIdx) };
  }

  // ── PTC-F — Parser con gramática de continuación (D9) ────────────
  function parsePTC(innerLines) {
    const fields = {};
    const seen = new Set();
    let i = 0;

    // PTC-F — LF es el único separador físico del bloque. Se comprueban
    // todas las líneas antes de interpretar la gramática, incluidas las
    // continuaciones de purpose. Una comprobación solo dentro del bucle
    // principal no alcanza las continuaciones, porque estas se consumen
    // en el bucle interno.
    if (innerLines.some(line => line.includes('\r'))) {
      return { valid: false, code: 'E_CR_NOT_ALLOWED_IN_PTC' };
    }

    while (i < innerLines.length) {
      const line = innerLines[i];

      if (line.startsWith('  ')) {
        return { valid: false, code: 'E_CONT_WITHOUT_KEY' };
      }
      const idx = line.indexOf(':');
      if (idx === -1) return { valid: false, code: 'E_MALFORMED_LINE' };

      // El protocolo solo trata U+0020 y U+0009 como whitespace
      // sintáctico de borde. No usar String.trim(), porque elimina un
      // conjunto mayor de caracteres Unicode y haría depender la norma
      // de la semántica específica de ECMAScript.
      const key = trimAsciiEdge(line.slice(0, idx));
      const value = trimAsciiEdge(line.slice(idx + 1));

      if (!FIELD_ORDER.includes(key)) return { valid: false, code: 'E_UNKNOWN_KEY' };
      if (seen.has(key)) return { valid: false, code: 'E_DUPLICATE_KEY' };
      seen.add(key);
      i++;

      const contValues = [];
      while (i < innerLines.length && innerLines[i].startsWith('  ')) {
        if (!MULTILINE_ALLOWED.has(key)) return { valid: false, code: 'E_CONT_NOT_ALLOWED_FOR_KEY' };
        const contVal = innerLines[i].slice(2); // quita exactamente los 2 espacios sintácticos
        if (contVal === '</PTC>') return { valid: false, code: 'E_PTC_CLOSE_AS_LOGICAL_LINE' };
        contValues.push(contVal);
        i++;
      }
      fields[key] = contValues.length ? [value, ...contValues].join('\n') : value;
    }

    // Orden normativo: las claves presentes deben respetar el orden de FIELD_ORDER
    const presentInOrder = FIELD_ORDER.filter(k => k in fields);
    const seenOrderCheck = Object.keys(fields);
    // (el propio bucle de parseo ya impone el orden físico == orden de aparición;
    //  aquí solo verificamos que ninguna clave aparece fuera de la secuencia normativa)
    let lastIdx = -1;
    for (const k of seenOrderCheck) {
      const idxInOrder = FIELD_ORDER.indexOf(k);
      if (idxInOrder < lastIdx) return { valid: false, code: 'E_FIELD_OUT_OF_ORDER' };
      lastIdx = idxInOrder;
    }

    const required = ['version','level','operator','date_utc','ai_system','co_creation_mode','human_review','purpose','hash_scope','hash_doc_sha256','hash_ptc_sha256','hash_ethical_context_sha256'];
    for (const r of required) {
      if (!(r in fields)) return { valid: false, code: 'E_MISSING_REQUIRED_FIELD', field: r };
    }

    return { valid: true, fields };
  }

  // ── Serialización — construcción del bloque PTC para generación ──
  function serializePTC(fields) {
    let out = '<PTC>\n';
    for (const key of FIELD_ORDER) {
      const v = fields[key];
      if (v === undefined || v === null || v === '') continue;
      if (key === 'purpose' && v.includes('\n')) {
        const [first, ...rest] = v.split('\n');
        out += `purpose: ${first}\n`;
        for (const r of rest) out += `  ${r}\n`;
      } else {
        out += `${key}: ${v}\n`;
      }
    }
    out += '</PTC>';
    return out;
  }

  // ── Validación semántica de campos (B2) ───────────────────────────
  const LEVEL_VALUES = new Set(['basic', 'standard', 'extended', 'other']);
  const HUMAN_REVIEW_VALUES = new Set(['full', 'partial', 'light']);
  const HEX64 = /^[0-9a-f]{64}$/;
  const DATE_UTC_FULL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
  // Perfiles de version admitidos por este núcleo. «6» se detecta aparte
  // para dar un mensaje específico: no es un valor inventado, es un
  // perfil histórico real que este núcleo todavía no valida formalmente.
  const SUPPORTED_VERSIONS = new Set(['R-01']);

  // Fecha real, no solo con la forma correcta: mes 01-12, día válido para
  // ese mes/año (incluye bisiestos), hora 00-23, minutos/segundos 00-59,
  // y la fecha reconstruida debe coincidir exactamente con la declarada
  // (rechaza p. ej. 2026-02-30, que Date() normalizaría silenciosamente
  // a marzo en vez de fallar).
  function isRealUtcDate(str) {
    const m = DATE_UTC_FULL.exec(str);
    if (!m) return false;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    // N-01 — decisión de Manuel, comunicada el 17/07/2026 vía mensaje
    // reenviado de GPT ("la decisión del operador es: años 0001-9999,
    // el año 0000 no es válido"). Rango admitido: 0001-9999.
    if (y < 1) return false;
    if (mo < 1 || mo > 12) return false;
    if (h > 23 || mi > 59 || s > 59) return false;
    // Cálculo gregoriano explícito. Evita la regla especial de Date.UTC
    // para años 00-99, que los desplaza internamente a 1900-1999.
    const leap = (y % 4 === 0) && (y % 100 !== 0 || y % 400 === 0);
    const daysByMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (d < 1 || d > daysByMonth[mo - 1]) return false;
    return true;
  }

  function validateFieldSemantics(f) {
    // Los campos textuales obligatorios deben tener contenido lógico real.
    // Esta comprobación es especialmente necesaria para purpose multilínea:
    // una secuencia compuesta solo por líneas vacías no cuenta como valor.
    for (const k of ['operator', 'ai_system', 'co_creation_mode', 'purpose']) {
      if (typeof f[k] !== 'string' || !/[^ \t\n]/.test(f[k])) return 'E_EMPTY_REQUIRED_FIELD';
    }
    if (f.version === '6') return 'E_UNSUPPORTED_HISTORICAL_PROFILE';
    if (!SUPPORTED_VERSIONS.has(f.version)) return 'E_UNSUPPORTED_VERSION';
    if (!LEVEL_VALUES.has(f.level)) return 'E_INVALID_LEVEL';
    if (f.human_review !== undefined && !HUMAN_REVIEW_VALUES.has(f.human_review)) return 'E_INVALID_HUMAN_REVIEW';
    // Bajo version: R-01 solo se admite ISO 8601 completo. El formato
    // corto YYYY-MM-DD perteneció a la compatibilidad retrospectiva de
    // artefactos ACS-6, que ahora se rechazan explícitamente arriba —
    // por tanto ya no hay ningún perfil vigente que admita fecha corta.
    if (!isRealUtcDate(f.date_utc)) return 'E_INVALID_DATE_UTC';
    for (const h of ['hash_doc_sha256', 'hash_ptc_sha256', 'hash_ethical_context_sha256']) {
      if (f[h] !== undefined && !HEX64.test(f[h])) return 'E_INVALID_HASH_FORMAT';
    }
    // B3 — «|» prohibido en los ocho campos usados en la fórmula del hash
    // ético: sin este control, «|» dentro de un valor puede desplazar el
    // límite entre campos y producir ambigüedad en la preimagen.
    const ETHICAL_FIELDS = ['version','level','operator','date_utc','ai_system','co_creation_mode','human_review','purpose'];
    for (const k of ETHICAL_FIELDS) {
      if (f[k] !== undefined && f[k].includes('|')) return 'E_PIPE_NOT_ALLOWED';
    }
    return null;
  }

  // ── Validación completa (D3 + D8 + B1 + B2) ───────────────────────
  async function validate(rawArtifactText) {
    // B1 — extracción SIEMPRE sobre texto bruto, nunca pre-normalizado.
    const ex = extractPTC(rawArtifactText);
    if (!ex.found) return { status: 'invalid', errors: [ex.code], warnings: [], fields: {}, ptcDetected: false };

    const parsed = parsePTC(ex.innerLines);
    if (!parsed.valid) return { status: 'invalid', errors: [parsed.code], warnings: [], fields: {}, ptcDetected: true };

    const f = parsed.fields;
    const errors = [], warnings = [];

    if (f.hash_scope && !KNOWN_SCOPES.includes(f.hash_scope)) errors.push('INVALID_HASH_SCOPE');

    const semError = validateFieldSemantics(f);
    if (semError) errors.push(semError);

    // hash_doc — SÍ se normaliza (R-01 §2), pero solo el prefijo documental.
    const normalizedDoc = normalizeText(ex.docTextRaw);
    const computedDoc = await computeHashDoc(normalizedDoc);
    const docMatch = computedDoc === f.hash_doc_sha256;
    if (!docMatch) errors.push('E005');

    // Vinculación entre hash_scope y el objeto realmente certificado.
    // hash_scope declara QUÉ TIPO de objeto se certifica; sin esta
    // comprobación, un artefacto puede declarar «referencia CSV+URL»
    // mientras certifica criptográficamente cualquier texto arbitrario,
    // con los tres hashes perfectamente autoconsistentes. No duplica las
    // reglas de CSV/URL: reconstruye con buildReferenceBody() y exige
    // igualdad byte a byte con el prefijo documental normalizado.
    if (f.hash_scope === 'reference_csv_url_normalized') {
      const refLines = normalizedDoc.split('\n');
      // normalizedDoc termina en un LF (regla 2.4) => última entrada del split es ''
      const contentLines = refLines.slice(0, -1);
      const csvLine = contentLines[0] || '';
      const urlLine = contentLines[1] || '';
      // No usar «.+» para extraer los valores: en ECMAScript el punto no
      // coincide con U+2028/U+2029, aunque R-01 solo reconoce CR y LF como
      // saltos prohibidos en este adaptador. La extracción se hace por
      // prefijo literal y el constructor común decide la conformidad.
      const csvValue = csvLine.startsWith('CSV: ') ? csvLine.slice('CSV: '.length) : null;
      const urlValue = urlLine.startsWith('URL: ') ? urlLine.slice('URL: '.length) : null;
      if (contentLines.length !== 2 || csvValue === null || urlValue === null) {
        errors.push('E_SCOPE_SHAPE_MISMATCH');
      } else {
        try {
          const reconstructed = buildReferenceBody(csvValue, urlValue);
          if (reconstructed !== normalizedDoc) errors.push('E_SCOPE_SHAPE_MISMATCH');
        } catch (e) {
          errors.push('E_SCOPE_SHAPE_MISMATCH');
        }
      }
    }

    // hash_ptc — NUNCA se normaliza. Preimagen física exacta (B1a).
    const computedPTC = await computeHashPTC(ex.ptcBlockRaw);
    const ptcMatch = computedPTC === f.hash_ptc_sha256;
    if (!ptcMatch) errors.push('E006');

    // Regeneración canónica y comparación — un artefacto puede tener sus
    // tres hashes autoconsistentes sobre una forma física NO canónica
    // (por ejemplo, un espacio de más antes de una clave) sin que ningún
    // hash lo detecte, porque el hash solo protege contra manipulación
    // posterior, no contra un formato no canónico desde el origen. Esto
    // viola el Principio de Conformidad de R-01: dos implementaciones
    // conformes deben producir el mismo objeto para la misma entrada.
    // Se cierra reconstruyendo el bloque con la misma función que usa
    // el generador y comparando byte a byte con el bloque recibido.
    const canonicalPTC = serializePTC(f);
    const isCanonicalForm = ex.ptcBlockRaw === canonicalPTC;
    if (!isCanonicalForm) errors.push('E_NON_CANONICAL_FORM');

    // D3/D8 — verificación real y obligatoria del hash ético, sin excepción
    const computedEthical = await computeEthicalContextHash(f);
    const ethicalMatch = computedEthical === f.hash_ethical_context_sha256;
    if (!ethicalMatch) errors.push('E007');

    // Nota informativa para artefactos históricos (version: 6) — D2 de la ronda anterior
    // Nota: la comprobación de version: 6 ocurre en validateFieldSemantics()
    // (E_UNSUPPORTED_HISTORICAL_PROFILE), antes de llegar aquí. Ya no hay
    // W030 — la nota informativa de la ronda anterior asumía compatibilidad
    // retrospectiva real que este núcleo todavía no implementa.

    const status = errors.length ? 'invalid' : warnings.length ? 'valid_warning' : 'valid';
    return {
      status, errors, warnings, fields: f, ptcDetected: true,
      declaredDoc: f.hash_doc_sha256, computedDoc, docMatch,
      declaredPTC: f.hash_ptc_sha256, computedPTC, ptcMatch,
      declaredEthical: f.hash_ethical_context_sha256, computedEthical, ethicalMatch,
      normalizedDoc, ptcBlockRaw: ex.ptcBlockRaw
    };
  }

  return {
    FIELD_ORDER, KNOWN_SCOPES,
    normalizeText, buildReferenceBody, trimAsciiEdge,
    computeHashDoc, computeHashPTC, computeEthicalContextHash,
    extractPTC, parsePTC, serializePTC,
    validate
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PTCCore;
if (typeof window !== 'undefined') window.PTCCore = PTCCore;

/* validate-pkg2.js — BETA-01
 * Verificación de Validator Package Format 2.0 (PKG-02), con FRS-01 y
 * DCL-03. Cuatro ejes SIEMPRE independientes: nunca se colapsan en un
 * único semáforo, nunca «prevalece el peor» (PKG-02 §34 de UI-01).
 * No modifica validate.js: es una ruta paralela, activada por detección
 * de formato antes de que el código histórico intervenga.
 */
const PTCValidatePackage2 = (() => {

  const FIXED_PATHS = {
    canonical: 'canonical/file_reference.txt',
    integrated: 'canonical/file_reference_with_ptc.txt',
    ptc: 'ptc.txt',
    readme: 'README.txt',
    manifest: 'manifest.json',
  };
  const KNOWN_TOP_LEVEL = ['source', 'canonical', 'PUBLIC_NOTICE'];
  const KNOWN_ROOT_FILES = ['ptc.txt', 'manifest.json', 'README.txt'];

  // ── Detección: ¿es esto un Package Format 2.0? ───────────────────────────
  // Solo se afirma tras comprobar manifest.json realmente, nunca por
  // extensión ni por nombre de archivo (Nivel 1 de nomenclatura, UI-01 §44).
  async function detectFormat(zip) {
    const manifestEntry = zip.file(FIXED_PATHS.manifest);
    if (!manifestEntry) return { family: 'unknown' };
    let manifest;
    try {
      manifest = JSON.parse(await manifestEntry.async('string'));
    } catch (_) {
      return { family: 'unknown', manifestParseError: true };
    }
    if (manifest && manifest.package_format_version === '2.0') {
      return { family: 'package2', manifest };
    }
    if (manifest && manifest.package_type === 'ptc-distribution') {
      return { family: 'legacy-v1', manifest };
    }
    return { family: 'unknown', manifest };
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function parseFileReferenceDescriptor(canonicalText) {
    // Reconocimiento por cabecera literal en posición fija (FRS-01 §15.2),
    // nunca por búsqueda de contenido en cualquier parte del texto.
    if (!canonicalText.startsWith('PTC FILE REFERENCE\n')) return null;
    const sizeMatch = /\nsize_bytes: (\d+)\n/.exec(canonicalText);
    const shaMatch = /\nsource_sha256: ([0-9a-f]{64})\n/.exec(canonicalText);
    if (!sizeMatch || !shaMatch) return null;
    return { sizeBytes: parseInt(sizeMatch[1], 10), sourceSha256: shaMatch[1] };
  }

  function parseDisclosureBlock(canonicalText) {
    const idx = canonicalText.indexOf('\nPTC DISCLOSURE\n');
    if (idx === -1) return null;
    const block = canonicalText.slice(idx + 1);
    const profileMatch = /^profile: (\S+)/m.exec(block);
    const typeMatch = /^type: (\S+)/m.exec(block);
    const langMatch = /^language: (\S+)/m.exec(block);
    const urlMatch = /^verification_url: (\S+)/m.exec(block);
    return {
      profile: profileMatch ? profileMatch[1] : null,
      type: typeMatch ? typeMatch[1] : null,
      language: langMatch ? langMatch[1] : null,
      verificationUrl: urlMatch ? urlMatch[1] : null,
    };
  }

  // ── Eje 1: Declaración PTC ────────────────────────────────────────────────
  async function checkPtcAxis(zip) {
    const entry = zip.file(FIXED_PATHS.integrated);
    if (!entry) {
      return { state: 'red', reason: 'MISSING_INTEGRATED_RECORD', result: null, canonicalText: null };
    }
    const integratedText = await entry.async('string');
    const result = await PTCCore.validate(integratedText);
    return {
      state: result.status === 'valid' ? 'green' : 'red',
      reason: result.status === 'valid' ? null : (result.errors || []).join(', ') || 'PTC_INVALID',
      result, integratedText,
      canonicalText: result.normalizedDoc != null ? result.normalizedDoc : null,
    };
  }

  // ── Eje 2: Archivo fuente ─────────────────────────────────────────────────
  async function checkSourceAxis(zip, canonicalText) {
    if (canonicalText == null) return { state: 'amber', reason: 'PTC_AXIS_UNAVAILABLE' };
    const descriptor = parseFileReferenceDescriptor(canonicalText);
    if (!descriptor) return { state: 'amber', reason: 'UNRECOGNIZED_PROFILE' };

    const sourceFiles = Object.keys(zip.files).filter(p => p.startsWith('source/') && !zip.files[p].dir);
    if (sourceFiles.length === 0) return { state: 'amber', reason: 'SOURCE_NOT_PROVIDED', descriptor };
    if (sourceFiles.length > 1) return { state: 'red', reason: 'MULTIPLE_SOURCE_ENTRIES', descriptor };

    const buffer = await zip.file(sourceFiles[0]).async('arraybuffer');
    if (buffer.byteLength !== descriptor.sizeBytes) {
      return { state: 'red', reason: 'SOURCE_MISMATCH', descriptor, realSize: buffer.byteLength };
    }
    const realSha = await sha256Hex(buffer);
    if (realSha !== descriptor.sourceSha256) {
      return { state: 'red', reason: 'SOURCE_MISMATCH', descriptor, realSha };
    }
    return { state: 'green', reason: null, descriptor, realSha, path: sourceFiles[0] };
  }

  // ── Eje 3: Estructura del paquete ─────────────────────────────────────────
  async function checkPackageAxis(zip, manifest, ptcAxis) {
    const issues = [];
    const SEVERITY = { green: 0, amber: 1, red: 2 };
    let worst = 'green';
    const escalate = (level) => { if (SEVERITY[level] > SEVERITY[worst]) worst = level; };

    for (const key of ['canonical', 'ptc', 'readme']) {
      if (!zip.file(FIXED_PATHS[key])) { issues.push(`MISSING_${key.toUpperCase()}`); escalate('red'); }
    }

    // Copias derivadas vs. registro integrado autoritativo (PKG-02 §7/§26):
    // el PTC se verifica contra el integrado (eje 1); aquí solo se
    // comprueba si las copias derivadas CONTRADICEN esa autoridad.
    if (ptcAxis.integratedText != null && zip.file(FIXED_PATHS.canonical) && zip.file(FIXED_PATHS.ptc)) {
      const extracted = PTCCore.extractPTC(ptcAxis.integratedText);
      if (extracted.found) {
        const [canonicalCopy, ptcCopy] = await Promise.all([
          zip.file(FIXED_PATHS.canonical).async('string'),
          zip.file(FIXED_PATHS.ptc).async('string'),
        ]);
        if (canonicalCopy !== extracted.docTextRaw) { issues.push('DERIVED_CANONICAL_MISMATCH'); escalate('red'); }
        if (ptcCopy !== extracted.ptcBlockRaw) { issues.push('DERIVED_PTC_MISMATCH'); escalate('red'); }
      }
    }

    if (!manifest) { issues.push('MANIFEST_MISSING'); escalate('red'); }
    else if (manifest.package_format_version !== '2.0') { issues.push('MANIFEST_VERSION_UNEXPECTED'); escalate('amber'); }

    // Entradas adicionales no declaradas (PKG-02 v0.4 §ADD-01/ADD-02):
    // seguras → ámbar y visibles; peligrosas/ambiguas/contradictorias → rojo.
    // Un único paso sobre TODAS las entradas no-directorio, sin distinguir
    // "archivo raíz" de "carpeta de primer nivel": una ruta que no encaja
    // en ninguna categoría conocida (source/, canonical/, PUBLIC_NOTICE/,
    // o uno de los tres archivos raíz fijos) es una entrada no declarada,
    // sea cual sea su forma exacta. JSZip normaliza «..» al leer, pero
    // preserva barras iniciales absolutas y contrabarras — ambas deben
    // detectarse aquí, no solo la primera.
    const allEntries = Object.keys(zip.files).filter(p => !zip.files[p].dir);
    const unexpected = allEntries.filter(p => {
      if (KNOWN_ROOT_FILES.includes(p)) return false;
      const firstSegment = p.split('/')[0];
      if (KNOWN_TOP_LEVEL.includes(firstSegment)) return false;
      return true;
    });
    if (unexpected.length) {
      const dangerous = unexpected.some(name => /\.\.|^\/|\\|[\x00-\x1f]/.test(name));
      if (dangerous) { issues.push('UNDECLARED_ENTRY_DANGEROUS'); escalate('red'); }
      else { issues.push('UNDECLARED_ENTRY_SAFE'); escalate('amber'); }
    }

    // Kit europeo de iconos (BETA-02) — cada activo se comprueba por SHA-256
    // contra lo declarado en manifest.public_notice.eu_icon_kit. Esto vive
    // enteramente en el eje Paquete: los archivos del kit no forman parte
    // del objeto canónico protegido ni del PTC, así que una alteración aquí
    // NUNCA puede tocar los ejes PTC, fuente o divulgación por sí sola.
    if (manifest && manifest.public_notice && manifest.public_notice.eu_icon_kit) {
      const kit = manifest.public_notice.eu_icon_kit;
      const checks = [
        ['black_svg_path', 'black_svg_sha256'], ['black_png_path', 'black_png_sha256'],
        ['white_svg_path', 'white_svg_sha256'], ['white_png_path', 'white_png_sha256'],
      ];
      for (const [pathKey, shaKey] of checks) {
        const p = kit[pathKey];
        const expectedSha = kit[shaKey];
        if (!p || !expectedSha) continue;
        const entry = zip.file(p);
        if (!entry) { issues.push('EU_ICON_MISSING'); escalate('red'); continue; }
        const buf = await entry.async('arraybuffer');
        const realSha = await sha256Hex(buf);
        if (realSha !== expectedSha) { issues.push('EU_ICON_ALTERED'); escalate('red'); }
      }
    }

    return { state: worst, issues };
  }

  // ── Eje 4: Divulgación pública (omitido si no hay señal alguna) ─────────
  function detectDisclosureSignal(zip, manifest, canonicalText) {
    if (canonicalText && canonicalText.includes('\nPTC DISCLOSURE\n')) return true;
    if (manifest && manifest.public_notice) return true;
    if (Object.keys(zip.files).some(p => p.startsWith('PUBLIC_NOTICE/') && !zip.files[p].dir)) return true;
    return false;
  }

  async function checkDisclosureAxis(zip, manifest, canonicalText) {
    const disclosure = canonicalText ? parseDisclosureBlock(canonicalText) : null;

    if (!disclosure) {
      // Hay señal (PUBLIC_NOTICE/ o manifest.public_notice) pero ningún
      // bloque protegido: intento de aviso sin declaración canónica.
      return { state: 'red', reason: 'NOTICE_WITHOUT_PROTECTED_BLOCK' };
    }
    if (!PTCFileReference.DCL_KNOWN_TYPES.includes(disclosure.type)) {
      return { state: 'amber', reason: 'UNKNOWN_TYPE', disclosure };
    }
    if (!PTCFileReference.DCL_KNOWN_LANGS.includes(disclosure.language)) {
      return { state: 'amber', reason: 'UNSUPPORTED_LANGUAGE', disclosure };
    }

    const noticeEntry = zip.file('PUBLIC_NOTICE/notice.txt');
    if (!noticeEntry) return { state: 'red', reason: 'NOTICE_MISSING', disclosure };

    const expectedNotice = PTCFileReference.buildNoticeText(disclosure.type, disclosure.language, disclosure.verificationUrl || undefined);
    const realNotice = await noticeEntry.async('string');
    if (realNotice !== expectedNotice) return { state: 'red', reason: 'NOTICE_MISMATCH', disclosure };

    // Coherencia public_notice (manifest) / PUBLIC_NOTICE/ (ZIP), PKG-02 §19.
    const hasFolder = Object.keys(zip.files).some(p => p.startsWith('PUBLIC_NOTICE/') && !zip.files[p].dir);
    const hasManifestEntry = !!(manifest && manifest.public_notice);
    if (hasFolder !== hasManifestEntry) {
      return { state: 'red', reason: 'MANIFEST_FOLDER_INCOHERENT', disclosure };
    }

    // QR: verificación opcional, informativa (DCL-03 §16/§24). Si existe y
    // no se puede decodificar aquí, no se penaliza — no es prueba criptográfica.
    return { state: 'green', reason: null, disclosure };
  }

  // ── Guardia previa contra ZIP hostil: se inspecciona el tamaño declarado
  // y la relación de compresión de CADA entrada usando solo los metadatos
  // del directorio central de JSZip — antes de descomprimir un solo byte.
  // Una bomba ZIP se rechaza aquí; nunca se llega a intentar leerla.
  const MAX_ENTRY_BYTES = 500 * 1024 * 1024; // 500 MB por entrada
  const MAX_RATIO = 300; // relación descomprimido:comprimido sospechosa

  function scanForHostileEntries(zip) {
    const offenders = [];
    Object.keys(zip.files).forEach(path => {
      const entry = zip.files[path];
      if (entry.dir || !entry._data) return;
      const { uncompressedSize: u, compressedSize: c } = entry._data;
      if (typeof u !== 'number') return;
      if (u > MAX_ENTRY_BYTES) { offenders.push({ path, reason: 'SIZE' }); return; }
      if (c > 0 && u / c > MAX_RATIO) { offenders.push({ path, reason: 'RATIO' }); }
    });
    return offenders;
  }

  // ── Orquestación completa ────────────────────────────────────────────────
  async function validatePackage2(file) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());

    const hostile = scanForHostileEntries(zip);
    if (hostile.length) {
      return {
        hostileRejection: true,
        offenders: hostile,
        ptcAxis: { state: 'red', reason: 'HOSTILE_ENTRY_REJECTED' },
        sourceAxis: { state: 'amber', reason: 'PTC_AXIS_UNAVAILABLE' },
        packageAxis: { state: 'red', issues: ['HOSTILE_ENTRY_REJECTED'] },
        disclosureAxis: null,
        manifest: null,
      };
    }

    const { manifest } = await detectFormat(zip);

    const ptcAxis = await checkPtcAxis(zip);
    const canonicalText = ptcAxis.canonicalText;

    const sourceAxis = await checkSourceAxis(zip, canonicalText);
    const packageAxis = await checkPackageAxis(zip, manifest, ptcAxis);

    const hasDisclosureSignal = detectDisclosureSignal(zip, manifest, canonicalText);
    const disclosureAxis = hasDisclosureSignal
      ? await checkDisclosureAxis(zip, manifest, canonicalText)
      : null;

    return { ptcAxis, sourceAxis, packageAxis, disclosureAxis, manifest };
  }

  // ── Presentación: cuatro bloques, nunca un semáforo único ────────────────
  function t(key, fallback) {
    try {
      if (typeof I18n !== 'undefined' && typeof I18n.getTranslation === 'function') {
        const v = I18n.getTranslation(key);
        if (v != null && v !== '') return v;
      }
    } catch (_) {}
    return fallback;
  }

  const COLORS = {
    green: { bg: 'var(--green-bg)', border: 'var(--green-border)', color: 'var(--green)', label: () => t('validate.pkg2.state.green', 'Correcto') },
    amber: { bg: 'var(--yellow-bg)', border: 'var(--yellow-border)', color: 'var(--yellow)', label: () => t('validate.pkg2.state.amber', 'Atención') },
    red: { bg: 'var(--red-bg)', border: 'var(--red-border)', color: 'var(--red)', label: () => t('validate.pkg2.state.red', 'No conforme') },
  };

  const REASON_MESSAGES = {
    MISSING_INTEGRATED_RECORD: 'validate.pkg2.reason.missing_integrated',
    SOURCE_NOT_PROVIDED: 'validate.pkg2.reason.source_not_provided',
    UNRECOGNIZED_PROFILE: 'validate.pkg2.reason.unrecognized_profile',
    MULTIPLE_SOURCE_ENTRIES: 'validate.pkg2.reason.multiple_source',
    SOURCE_MISMATCH: 'validate.pkg2.reason.source_mismatch',
    PTC_AXIS_UNAVAILABLE: 'validate.pkg2.reason.ptc_axis_unavailable',
    NOTICE_WITHOUT_PROTECTED_BLOCK: 'validate.pkg2.reason.notice_without_block',
    UNKNOWN_TYPE: 'validate.pkg2.reason.unknown_type',
    UNSUPPORTED_LANGUAGE: 'validate.pkg2.reason.unsupported_language',
    NOTICE_MISSING: 'validate.pkg2.reason.notice_missing',
    NOTICE_MISMATCH: 'validate.pkg2.reason.notice_mismatch',
    MANIFEST_FOLDER_INCOHERENT: 'validate.pkg2.reason.manifest_folder_incoherent',
    HOSTILE_ENTRY_REJECTED: 'validate.pkg2.reason.hostile_entry',
  };
  const DEFAULT_REASON_TEXT = {
    MISSING_INTEGRATED_RECORD: 'No se encuentra canonical/file_reference_with_ptc.txt.',
    SOURCE_NOT_PROVIDED: 'No se ha aportado el archivo original. La declaración puede verificarse, pero no la fuente.',
    UNRECOGNIZED_PROFILE: 'El perfil de referencia no se reconoce. No se ha realizado una comparación de fuente.',
    MULTIPLE_SOURCE_ENTRIES: 'Hay más de un archivo bajo source/. FRS-01 exige exactamente uno.',
    SOURCE_MISMATCH: 'El archivo aportado es diferente del vinculado.',
    PTC_AXIS_UNAVAILABLE: 'No se puede comprobar la fuente porque la declaración PTC no es válida.',
    NOTICE_WITHOUT_PROTECTED_BLOCK: 'Existen artefactos de aviso sin una declaración protegida que los sustente.',
    UNKNOWN_TYPE: 'El tipo de intervención declarado no se reconoce.',
    UNSUPPORTED_LANGUAGE: 'El idioma declarado no está soportado en esta versión.',
    NOTICE_MISSING: 'Falta PUBLIC_NOTICE/notice.txt.',
    NOTICE_MISMATCH: 'El aviso incluido no coincide con el que debe generar el perfil.',
    MANIFEST_FOLDER_INCOHERENT: 'La presencia de PUBLIC_NOTICE/ y de public_notice en el manifiesto no es coherente.',
    HOSTILE_ENTRY_REJECTED: 'El paquete contiene una entrada con un tamaño o una relación de compresión anómalos. Se ha rechazado por seguridad, sin descomprimirla.',
  };
  const PACKAGE_ISSUE_TEXT = {
    MISSING_CANONICAL: 'Falta canonical/file_reference.txt.',
    MISSING_PTC: 'Falta ptc.txt.',
    MISSING_README: 'Falta README.txt.',
    DERIVED_CANONICAL_MISMATCH: 'canonical/file_reference.txt no coincide con el cuerpo del registro integrado.',
    DERIVED_PTC_MISMATCH: 'ptc.txt no coincide con el bloque PTC del registro integrado.',
    MANIFEST_MISSING: 'Falta manifest.json.',
    MANIFEST_VERSION_UNEXPECTED: 'manifest.json no declara package_format_version 2.0.',
    UNDECLARED_ENTRY_SAFE: 'Hay entradas adicionales no declaradas en el manifiesto (seguras).',
    UNDECLARED_ENTRY_DANGEROUS: 'Hay entradas adicionales peligrosas, ambiguas o contradictorias.',
    HOSTILE_ENTRY_REJECTED: 'El paquete contiene una entrada con un tamaño o una relación de compresión anómalos. Se ha rechazado por seguridad, sin descomprimirla.',
    EU_ICON_MISSING: 'Falta un archivo del kit europeo declarado en manifest.json.',
    EU_ICON_ALTERED: 'Un archivo del kit europeo no coincide con el SHA-256 declarado en manifest.json.',
  };

  function axisBlockHTML(state, mainText, extraLines) {
    const c = COLORS[state];
    const lines = (extraLines || []).map(l => `<div style="margin-top:.25rem;font-size:.85rem;">${l}</div>`).join('');
    return `<div style="display:flex;align-items:flex-start;gap:.6rem;padding:.6rem .8rem;border-radius:6px;background:${c.bg};border:1px solid ${c.border};">
      <span style="font-weight:700;color:${c.color};white-space:nowrap;">${c.label()}</span>
      <span>${mainText}${lines}</span>
    </div>`;
  }

  function render(state) {
    document.getElementById('validation-report').style.display = 'none';
    document.getElementById('package2-report').style.display = 'block';

    const banner = document.getElementById('format-detected-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.textContent = t('validate.format.package2', 'Formato detectado: Validator Package Format 2.0');
    }

    const { ptcAxis, sourceAxis, packageAxis, disclosureAxis } = state;

    document.getElementById('pkg2-axis-ptc').innerHTML = axisBlockHTML(
      ptcAxis.state,
      ptcAxis.state === 'green'
        ? t('validate.pkg2.ptc_valid', 'La declaración PTC es válida para este objeto canónico.')
        : t('validate.pkg2.ptc_invalid', 'La declaración PTC o el objeto protegido no son conformes.')
    );

    document.getElementById('pkg2-axis-source').innerHTML = axisBlockHTML(
      sourceAxis.state,
      sourceAxis.state === 'green'
        ? t('validate.pkg2.source_valid', 'El archivo coincide exactamente con el vinculado.')
        : t(REASON_MESSAGES[sourceAxis.reason], DEFAULT_REASON_TEXT[sourceAxis.reason] || sourceAxis.reason)
    );

    const packageIssuesHTML = (packageAxis.issues || []).map(i => '· ' + t('validate.pkg2.issue.' + i.toLowerCase(), PACKAGE_ISSUE_TEXT[i] || i));
    document.getElementById('pkg2-axis-package').innerHTML = axisBlockHTML(
      packageAxis.state,
      packageAxis.state === 'green'
        ? t('validate.pkg2.package_valid', 'La estructura del paquete es conforme.')
        : t('validate.pkg2.package_issues', 'Se han detectado incidencias en la estructura del paquete:'),
      packageIssuesHTML
    );

    const disclosureContainer = document.getElementById('pkg2-axis-disclosure-container');
    const omittedNote = document.getElementById('pkg2-disclosure-omitted');
    if (disclosureAxis) {
      disclosureContainer.style.display = 'block';
      omittedNote.style.display = 'none';
      document.getElementById('pkg2-axis-disclosure').innerHTML = axisBlockHTML(
        disclosureAxis.state,
        disclosureAxis.state === 'green'
          ? t('validate.pkg2.disclosure_valid', 'El aviso público coincide con la declaración protegida.')
          : t(REASON_MESSAGES[disclosureAxis.reason], DEFAULT_REASON_TEXT[disclosureAxis.reason] || disclosureAxis.reason)
      );
    } else {
      disclosureContainer.style.display = 'none';
      omittedNote.style.display = 'block';
    }

    const details = document.getElementById('pkg2-details-block');
    if (details) {
      const fields = (ptcAxis.result && ptcAxis.result.fields) || {};
      const entries = Object.entries(fields);
      details.textContent = entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join('\n') : '—';
    }

    document.getElementById('pkg2-channel-incident').style.display = 'none';
  }

  return { detectFormat, validatePackage2, parseFileReferenceDescriptor, parseDisclosureBlock, render };
})();

if (typeof window !== 'undefined') window.PTCValidatePackage2 = PTCValidatePackage2;

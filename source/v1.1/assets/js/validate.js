(() => {
  const $ = id => document.getElementById(id);
  function show(id) { const e = $(id); if (e) e.style.display = 'block'; }
  function hide(id) { const e = $(id); if (e) e.style.display = 'none'; }

  function t(key, fallback = '') {
    try {
      if (typeof I18n !== 'undefined') {
        if (typeof I18n.getTranslation === 'function') {
          const value = I18n.getTranslation(key);
          if (value != null && value !== '') return value;
        }
        if (typeof I18n.t === 'function') return I18n.t(key, fallback || '');
      }
    } catch (_) {}
    return fallback || key;
  }

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function withTimeout(promise, ms, code) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(code)), ms);
      promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); }
      );
    });
  }

  function manifestPath(entry) {
    return entry && (entry.path || entry.name) ? String(entry.path || entry.name) : '';
  }

  function manifestFiles(manifest) {
    return Array.isArray(manifest && manifest.files)
      ? manifest.files.map(file => ({ path: manifestPath(file), role: String(file.role || 'file') })).filter(file => file.path)
      : [];
  }

  function guessRole(path) {
    if (path === 'canonical/document_with_ptc.txt' || path === 'document_with_ptc.txt') return 'canonical_artifact';
    if (path === 'canonical/document.txt' || path === 'document.txt') return 'canonical_document';
    if (path === 'ptc.txt') return 'ptc_block';
    if (path === 'manifest.json') return 'manifest';
    if (/^readme\.txt$/i.test(path)) return 'documentation';
    if (path.startsWith('source/')) return 'source_original';
    if (/\.md$/i.test(path) && path.startsWith('representations/')) return 'representation_markdown';
    if (/\.docx$/i.test(path)) return 'representation_docx';
    if (/\.pdf$/i.test(path)) return 'representation_pdf';
    return 'file';
  }

  function fileLikeFromZipEntry(entry, name, type = '') {
    return {
      name,
      type,
      async arrayBuffer() { return await entry.async('arraybuffer'); }
    };
  }

  async function readZipTextStrict(entry) {
    if (!entry) throw new Error('ZIP entry missing');
    if (typeof PTCAdapters === 'undefined') throw new Error('PTCAdapters not loaded');
    return await PTCAdapters.decodeUtf8Strict(await entry.async('uint8array'));
  }

  function findDeclaredPath(files, role) {
    const item = files.find(file => file.role === role);
    return item ? item.path : '';
  }

  function firstExistingPath(zip, candidates) {
    for (const candidate of candidates) {
      if (candidate && zip.file(candidate)) return candidate;
    }
    return '';
  }

  async function extractFromZIP(file) {
    if (!window.JSZip) throw new Error('JSZip not loaded');
    if (typeof PTCAdapters === 'undefined') throw new Error('PTCAdapters not loaded');

    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    let manifest = null;
    let manifestParseError = false;
    const manifestEntry = zip.file('manifest.json');

    if (manifestEntry) {
      try {
        manifest = JSON.parse(await readZipTextStrict(manifestEntry));
      } catch (_) {
        manifestParseError = true;
      }
    }

    let files = manifestFiles(manifest);
    if (!files.length) {
      files = Object.keys(zip.files)
        .filter(path => !zip.files[path].dir)
        .map(path => ({ path, role: guessRole(path) }));
    }

    const canonicalPath = firstExistingPath(zip, [
      findDeclaredPath(files, 'canonical_artifact'),
      'canonical/document_with_ptc.txt',
      'document_with_ptc.txt'
    ]);

    if (!canonicalPath) throw new Error('canonical_artifact not found in ZIP');
    const text = await readZipTextStrict(zip.file(canonicalPath));

    return {
      ext: 'zip',
      text,
      experimental: false,
      adapter: 'ptc-distribution-zip',
      package: { zip, manifest, files, canonicalPath, manifestParseError }
    };
  }

  async function extractByType(file) {
    if (typeof PTCAdapters === 'undefined') throw new Error('PTCAdapters not loaded');
    const ext = PTCAdapters.extensionOf(file && file.name);
    if (ext === 'zip') return await extractFromZIP(file);
    return await PTCAdapters.extractArtifact(file);
  }

  async function validateRepresentation(entry, path, expectedHash) {
    try {
      const file = fileLikeFromZipEntry(entry, path);
      const extracted = await PTCAdapters.extractArtifact(file);
      const check = await PTCCore.validate(extracted.text);
      const sameDocument = check.fields && check.fields.hash_doc_sha256 === expectedHash;
      return check.status === 'valid' && sameDocument ? 'valid' : 'mismatch';
    } catch (_) {
      return 'error';
    }
  }

  async function inspectPackage(packageInfo, canonicalResult) {
    if (!packageInfo) return { fileResults: {}, notes: [] };

    const { zip, manifest, files, canonicalPath, manifestParseError } = packageInfo;
    const fileResults = {};
    const notes = [];
    const expectedHash = canonicalResult.fields && canonicalResult.fields.hash_doc_sha256;

    if (manifestParseError) notes.push('PACKAGE_MANIFEST_INVALID');
    if (!manifest) notes.push('PACKAGE_MANIFEST_MISSING');

    for (const file of files) {
      fileResults[file.path] = zip.file(file.path) ? 'present' : 'missing';
    }

    fileResults[canonicalPath] = canonicalResult.status === 'valid' ? 'valid' : 'mismatch';

    if (manifest) {
      const hashPairs = [
        ['hash_doc_sha256', canonicalResult.fields.hash_doc_sha256],
        ['hash_ptc_sha256', canonicalResult.fields.hash_ptc_sha256],
        ['hash_ethical_context_sha256', canonicalResult.fields.hash_ethical_context_sha256]
      ];
      const mismatch = hashPairs.some(([key, value]) => manifest[key] && manifest[key] !== value);
      if (mismatch) notes.push('PACKAGE_MANIFEST_HASH_MISMATCH');

      if (manifest.package_type && !['ptc-distribution', 'ptc-canonical'].includes(manifest.package_type)) {
        notes.push('PACKAGE_TYPE_UNKNOWN');
      }
      if (manifest.package_type === 'ptc-canonical') notes.push('PACKAGE_LEGACY_TERMINOLOGY');
    }

    const canonicalDocPath = firstExistingPath(zip, [
      findDeclaredPath(files, 'canonical_document'),
      'canonical/document.txt',
      'document.txt'
    ]);
    if (canonicalDocPath) {
      try {
        const canonicalDoc = await readZipTextStrict(zip.file(canonicalDocPath));
        fileResults[canonicalDocPath] = canonicalDoc === canonicalResult.normalizedDoc ? 'valid' : 'mismatch';
        if (fileResults[canonicalDocPath] !== 'valid') notes.push('PACKAGE_CANONICAL_DOCUMENT_MISMATCH');
      } catch (_) {
        fileResults[canonicalDocPath] = 'error';
        notes.push('PACKAGE_CANONICAL_DOCUMENT_ERROR');
      }
    } else if (manifest && manifest.package_type === 'ptc-distribution') {
      notes.push('PACKAGE_CANONICAL_DOCUMENT_MISSING');
    }

    const ptcPath = firstExistingPath(zip, [findDeclaredPath(files, 'ptc_block'), 'ptc.txt']);
    if (ptcPath) {
      try {
        const isolatedPTC = await readZipTextStrict(zip.file(ptcPath));
        fileResults[ptcPath] = isolatedPTC === canonicalResult.ptcBlockRaw ? 'valid' : 'mismatch';
        if (fileResults[ptcPath] !== 'valid') notes.push('PACKAGE_PTC_BLOCK_MISMATCH');
      } catch (_) {
        fileResults[ptcPath] = 'error';
        notes.push('PACKAGE_PTC_BLOCK_ERROR');
      }
    } else if (manifest) {
      notes.push('PACKAGE_PTC_BLOCK_MISSING');
    }

    const sourcePath = firstExistingPath(zip, [
      findDeclaredPath(files, 'source_original'),
      manifest && manifest.source && manifest.source.path
    ]);
    if (sourcePath) {
      try {
        const sourceEntry = zip.file(sourcePath);
        const sourceName = (manifest && manifest.source && manifest.source.original_name) || sourcePath.split('/').pop();
        const sourceFile = fileLikeFromZipEntry(sourceEntry, sourceName, manifest && manifest.source && manifest.source.media_type);
        const source = await PTCAdapters.extractSource(sourceFile);
        const sourceHash = await PTCCore.computeHashDoc(PTCCore.normalizeText(source.text));
        fileResults[sourcePath] = sourceHash === expectedHash ? 'valid' : 'mismatch';
        if (fileResults[sourcePath] !== 'valid') notes.push('PACKAGE_SOURCE_DIVERGES');
      } catch (_) {
        fileResults[sourcePath] = 'error';
        notes.push('PACKAGE_SOURCE_NOT_REPRODUCIBLE');
      }
    } else if (canonicalResult.fields.hash_scope === 'document_without_ptc_normalized' && manifest && manifest.package_type === 'ptc-distribution') {
      notes.push('PACKAGE_SOURCE_MISSING');
    }

    for (const file of files) {
      if (!['representation_markdown', 'representation_docx', 'representation_pdf'].includes(file.role)) continue;
      const entry = zip.file(file.path);
      if (!entry) { fileResults[file.path] = 'missing'; continue; }
      fileResults[file.path] = await validateRepresentation(entry, file.path, expectedHash);
      if (fileResults[file.path] !== 'valid') notes.push('PACKAGE_REPRESENTATION_DIVERGES');
    }

    return { fileResults, notes };
  }

  // ── Rendering ────────────────────────────────────────────
  function renderPreflight({ fileOk, textOk, format, experimental, ptcDetected, note }) {
    const rows = $('preflight-rows');
    if (!rows) return;
    const items = [
      { ok: fileOk, text: t(fileOk ? 'validate.preflight.file_loaded_ok' : 'validate.preflight.file_loaded_fail', fileOk ? 'Archivo cargado' : 'No se pudo cargar el archivo') },
      { ok: textOk, text: t(textOk ? 'validate.preflight.text_extracted_ok' : 'validate.preflight.text_extracted_fail', textOk ? 'Texto extraído' : 'Falló la extracción') },
      { ok: true, text: `${t('validate.preflight.format', 'Formato')}: ${format}${experimental ? ' ' + t('validate.preflight.format_experimental', '(experimental)') : ''}` }
    ];
    if (ptcDetected !== null) {
      items.push({ ok: ptcDetected, text: t(ptcDetected ? 'validate.preflight.ptc_detected_yes' : 'validate.preflight.ptc_detected_no', ptcDetected ? 'PTC detectado' : 'PTC no encontrado') });
    }
    if (note) items.push({ ok: null, text: `${t('validate.preflight.note', 'Nota')}: ${note}` });

    rows.innerHTML = items.map(item => `
      <div class="preflight-row">
        <span>${item.ok === true ? '✅' : item.ok === false ? '❌' : '⚠️'}</span>
        <span>${escapeHTML(item.text)}</span>
      </div>`).join('');
  }

  function renderSemaphore(statusKey) {
    const box = $('semaphore-box');
    const label = $('semaphore-label');
    const sub = $('semaphore-sub');
    const explanation = $('semaphore-explanation');
    if (!box) return;

    let cls = 'invalid';
    let path = 'validate.report.result.invalid';
    if (statusKey === 'valid') { cls = 'valid'; path = 'validate.report.result.valid'; }
    else if (statusKey === 'valid_warning') { cls = 'warning'; path = 'validate.report.result.valid_warning'; }
    else if (statusKey === 'no_ptc') { path = 'validate.report.result.no_ptc'; }
    else if (statusKey === 'ptc_invalid') { path = 'validate.report.result.ptc_invalid'; }
    else if (statusKey === 'extraction_failed') { path = 'validate.report.result.extraction_failed'; }
    else if (statusKey === 'unexpected_error') { path = 'validate.report.result.unexpected_error'; }

    // El nombre público es siempre uno de tres, independientemente del
    // motivo técnico concreto (que sigue disponible, específico, en el
    // mensaje de debajo). "Válido" nunca se usa hacia fuera: puede
    // interpretarse como certificación de verdad o cumplimiento jurídico.
    const publicTitleKey = cls === 'valid' ? 'validate.report.result.public_title.conforme'
      : cls === 'warning' ? 'validate.report.result.public_title.conforme_avisos'
      : 'validate.report.result.public_title.no_conforme';
    const publicTitleFallback = cls === 'valid' ? 'Conforme' : cls === 'warning' ? 'Conforme con avisos' : 'No conforme';

    box.className = `semaphore ${cls}`;
    if (label) label.textContent = t(publicTitleKey, publicTitleFallback);
    if (sub) sub.textContent = t(`${path}.message`, '');
    if (explanation) explanation.textContent = t(`${path}.explanation`, '');
  }

  function renderCheckRows(data) {
    const container = $('check-rows');
    if (!container) return;
    const state = match => match === null ? t('validate.checks.not_computed', 'no calculado') : match ? t('validate.checks.match', 'coincide') : t('validate.checks.mismatch', 'no coincide');
    const icon = match => match === true ? '✅' : match === false ? '❌' : '⚠️';
    const rows = [
      ['doc_hash', 'Hash documental', data.docMatch],
      ['ptc_hash', 'Hash PTC', data.ptcMatch],
      ['ethical_hash', 'Hash del contexto ético', data.ethicalMatch]
    ];

    // Resumen comprensible: solo icono, nombre y si coincide o no. Los
    // valores declarado/calculado, que son el detalle técnico, se anexan
    // al bloque plegado — nunca en la primera lectura (§7).
    container.innerHTML = rows.map(([key, fallback, match]) => `
      <div class="check-row">
        <span class="check-icon">${icon(match)}</span>
        <div class="check-label">${escapeHTML(t(`validate.checks.${key}`, fallback))}: ${escapeHTML(state(match))}</div>
      </div>`).join('');
  }

  function renderHashValuesDetail(data) {
    const container = $('hash-values-detail');
    if (!container) return;
    const rows = [
      ['doc_hash', 'Hash documental', data.declaredDoc, data.computedDoc],
      ['ptc_hash', 'Hash PTC', data.declaredPTC, data.computedPTC],
      ['ethical_hash', 'Hash del contexto ético', data.declaredEthical, data.computedEthical]
    ];
    container.innerHTML = rows.filter(([,,d,c]) => d || c).map(([key, fallback, declared, computed]) => `
      <div class="check-row">
        <div>
          <div class="check-label">${escapeHTML(t(`validate.checks.${key}`, fallback))}</div>
          ${declared ? `<div class="check-hash">${escapeHTML(t('validate.checks.declared', 'declarado'))}: ${escapeHTML(declared)}</div>` : ''}
          ${computed ? `<div class="check-hash">${escapeHTML(t('validate.checks.computed', 'calculado'))}: ${escapeHTML(computed)}</div>` : ''}
        </div>
      </div>`).join('');
  }

  function renderErrorsWarnings({ errors = [], warnings = [] }) {
    const container = $('error-warning-block');
    if (!container) return;
    if (!errors.length && !warnings.length) { container.innerHTML = ''; return; }

    const lines = [];
    errors.forEach(code => lines.push(`<div class="preflight-row"><span>❌</span><span>${escapeHTML(t(`validate.errors.${code}`, code))}</span></div>`));
    warnings.forEach(code => lines.push(`<div class="preflight-row"><span>⚠️</span><span>${escapeHTML(t(`validate.warnings.${code}`, code))}</span></div>`));
    container.innerHTML = `<div class="preflight-rows" style="margin-top:.75rem;">${lines.join('')}</div>`;
  }

  function packageState(path, role, fileResults, isCanonicalValid) {
    if (role === 'canonical_artifact') return isCanonicalValid ? 'valid' : 'mismatch';
    return fileResults[path] || 'present';
  }

  function renderPackageSchema(packageView, statusKey) {
    const container = $('package-schema');
    if (!container || !packageView) { if (container) container.style.display = 'none'; return; }

    const files = packageView.files || [];
    const results = packageView.fileResults || {};
    const notes = packageView.notes || [];
    const isCanonicalValid = statusKey === 'valid' || statusKey === 'valid_warning';

    const roleIcon = {
      source_original: '📥', canonical_document: '📃', canonical_artifact: '📄',
      representation_markdown: 'Ⓜ️', representation_docx: '📝', representation_pdf: '📑',
      ptc_block: '🔏', manifest: '📋', documentation: '📖', file: '📎'
    };
    const roleFallback = {
      source_original: 'fuente original', canonical_document: 'objeto canónico sin PTC', canonical_artifact: 'artefacto canónico con PTC',
      representation_markdown: 'representación Markdown', representation_docx: 'representación DOCX', representation_pdf: 'representación PDF',
      ptc_block: 'bloque PTC', manifest: 'manifest', documentation: 'documentación', file: 'archivo'
    };
    const stateMeta = {
      valid: ['🟢', t('validate.schema.rep_valid', 'conforme'), 'var(--green)'],
      mismatch: ['🔴', t('validate.schema.rep_mismatch', 'divergente'), 'var(--red)'],
      missing: ['⬜', t('validate.schema.rep_missing', 'no encontrado'), 'var(--ink-faint)'],
      error: ['⚠️', t('validate.schema.rep_error', 'no verificable'), 'var(--yellow)'],
      present: ['⚪', t('validate.schema.present', 'presente'), 'var(--ink-faint)']
    };

    const rows = files.map(file => {
      const path = file.path || file.name || '';
      const role = file.role || 'file';
      const status = packageState(path, role, results, isCanonicalValid);
      const meta = stateMeta[status] || stateMeta.present;
      const label = t(`validate.schema.${role}`, roleFallback[role] || role);
      return `<div style="display:flex;align-items:center;gap:.6rem;padding:.3rem 0;border-bottom:1px solid var(--border);font-size:.83rem;">
        <span>${meta[0]}</span>
        <span style="font-family:var(--font-mono);color:var(--ink);overflow-wrap:anywhere">${escapeHTML(path)}</span>
        <span style="color:var(--ink-faint);font-size:.75rem;">${roleIcon[role] || '📎'} ${escapeHTML(label)}</span>
        <span style="margin-left:auto;font-size:.75rem;color:${meta[2]};font-weight:600">${escapeHTML(meta[1])}</span>
      </div>`;
    });

    const noteRows = notes.map(code => `<div class="preflight-row" style="margin-top:.35rem"><span>ℹ️</span><span>${escapeHTML(t(`validate.package.${code}`, code))}</span></div>`).join('');
    container.innerHTML = `
      <h3 style="font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);margin:0 0 .5rem;font-family:var(--font-body);">
        📦 ${escapeHTML(t('validate.schema.title', 'Contenido del paquete de distribución'))}
      </h3>
      <div style="border:1px solid var(--border);border-radius:8px;padding:.75rem;background:var(--surface-alt);">
        ${rows.join('')}
      </div>
      ${noteRows ? `<div class="preflight-rows" style="margin-top:.5rem">${noteRows}</div>` : ''}`;
    container.style.display = 'block';
  }

  function renderDetails(fields) {
    const el = $('details-block');
    if (!el) return;
    const entries = Object.entries(fields || {});
    el.textContent = entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join('\n') : '—';
  }

  let lastState = null;
  let lastPkg2State = null;

  async function validateFile(file) {
    const warnings = [];
    const errors = [];
    let extracted;
    let fmt = '—';
    let experimental = false;

    try {
      extracted = await withTimeout(extractByType(file), 25000, 'EXTRACTION_TIMEOUT');
      fmt = (extracted.ext || '—').toUpperCase();
      experimental = !!extracted.experimental;
      if (experimental) warnings.push('W020');
    } catch (error) {
      const state = {
        fileOk: true, textOk: false, fmt, experimental, ptcDetected: null, note: null,
        statusKey: 'extraction_failed', docMatch: null, ptcMatch: null, ethicalMatch: null,
        declaredDoc: null, computedDoc: null, declaredPTC: null, computedPTC: null,
        declaredEthical: null, computedEthical: null,
        warnings: [], errors: ['EXTRACTION_FAILED'], fields: {}, packageView: null
      };
      lastState = state; renderReport(state); return;
    }

    const rawText = extracted.text || '';
    if (!rawText.trim()) {
      const state = {
        fileOk: true, textOk: false, fmt, experimental, ptcDetected: null,
        note: experimental ? t('validate.warnings.W020', 'Adaptador experimental') : null,
        statusKey: 'extraction_failed', docMatch: null, ptcMatch: null, ethicalMatch: null,
        declaredDoc: null, computedDoc: null, declaredPTC: null, computedPTC: null,
        declaredEthical: null, computedEthical: null,
        warnings: [], errors: ['EXTRACTION_EMPTY'], fields: {}, packageView: null
      };
      lastState = state; renderReport(state); return;
    }

    if (typeof PTCCore === 'undefined') {
      const state = {
        fileOk: true, textOk: true, fmt, experimental, ptcDetected: null, note: null,
        statusKey: 'unexpected_error', docMatch: null, ptcMatch: null, ethicalMatch: null,
        declaredDoc: null, computedDoc: null, declaredPTC: null, computedPTC: null,
        declaredEthical: null, computedEthical: null,
        warnings: [], errors: ['ENGINE_NOT_LOADED'], fields: {}, packageView: null
      };
      lastState = state; renderReport(state); return;
    }

    const result = await PTCCore.validate(rawText);
    (result.warnings || []).forEach(code => warnings.push(code));
    (result.errors || []).forEach(code => errors.push(code));

    let packageView = null;
    if (extracted.package && result.status === 'valid') {
      const packageCheck = await inspectPackage(extracted.package, result);
      packageView = {
        manifest: extracted.package.manifest,
        files: extracted.package.files,
        fileResults: packageCheck.fileResults,
        notes: packageCheck.notes
      };
    } else if (extracted.package) {
      packageView = {
        manifest: extracted.package.manifest,
        files: extracted.package.files,
        fileResults: {},
        notes: extracted.package.manifestParseError ? ['PACKAGE_MANIFEST_INVALID'] : []
      };
    }

    const state = {
      fileOk: true, textOk: true, fmt, experimental,
      ptcDetected: result.ptcDetected,
      note: experimental ? t('validate.warnings.W020', 'La extracción de este formato es experimental.') : null,
      statusKey: result.status,
      packageView,
      docMatch: result.docMatch, ptcMatch: result.ptcMatch, ethicalMatch: result.ethicalMatch,
      declaredDoc: result.declaredDoc, computedDoc: result.computedDoc,
      declaredPTC: result.declaredPTC, computedPTC: result.computedPTC,
      declaredEthical: result.declaredEthical, computedEthical: result.computedEthical,
      warnings, errors, fields: result.fields || {}
    };
    lastState = state;
    renderReport(state);
  }

  function renderReport(state) {
    renderPreflight({
      fileOk: state.fileOk, textOk: state.textOk, format: state.fmt,
      experimental: state.experimental, ptcDetected: state.ptcDetected, note: state.note
    });
    renderSemaphore(state.statusKey);
    renderPackageSchema(state.packageView || null, state.statusKey);
    renderCheckRows(state);
    renderHashValuesDetail(state);
    renderErrorsWarnings({ errors: state.errors, warnings: state.warnings });
    renderDetails(state.fields);
    show('validation-details');
    showResultLimitNote();
  }

  function focusResult(id) {
    const el = $(id);
    if (el) { try { el.focus({ preventScroll: false }); } catch (_) { el.focus(); } }
  }

  function showResultLimitNote() {
    const note = $('result-limit-note');
    if (note) note.style.display = 'block';
  }

  async function onFileSelected(file) {
    hide('idle-message');
    hide('validation-report');
    show('processing-message');
    const processing = $('processing-message');
    if (processing) processing.textContent = t('validate.processing', 'Verificando…');

    try {
      await validateFile(file);
    } catch (error) {
      console.error(error);
      const state = {
        fileOk: true, textOk: false, fmt: '—', experimental: false, ptcDetected: null, note: null,
        statusKey: 'unexpected_error', docMatch: null, ptcMatch: null, ethicalMatch: null,
        declaredDoc: null, computedDoc: null, declaredPTC: null, computedPTC: null,
        declaredEthical: null, computedEthical: null,
        warnings: [], errors: ['UNEXPECTED_ERROR'], fields: {}, packageView: null
      };
      lastState = state; renderReport(state);
    }

    hide('processing-message');
    show('validation-report');
    focusResult('validation-report');
  }

  function waitForI18n(callback, attempts = 20) {
    let count = 0;
    const check = () => {
      if (typeof I18n !== 'undefined') return callback();
      if (++count < attempts) setTimeout(check, 100);
      else callback();
    };
    check();
  }

  // ── Reinicio único de estados (fallo crítico, confirmado y reproducido) ──
  // Se ejecuta al principio de cada nueva selección, antes de cualquier
  // detección de formato. Oculta y limpia los cinco estados posibles para
  // que un resultado del archivo anterior nunca conviva con el nuevo.
  function resetValidateState() {
    hide('idle-message');
    hide('processing-message');
    hide('validation-report');
    hide('ordinary-zip-message');
    hide('result-limit-note');
    hide('validation-details');
    const pkg2report = $('package2-report');
    if (pkg2report) pkg2report.style.display = 'none';
    const banner = $('format-detected-banner');
    if (banner) { banner.style.display = 'none'; banner.textContent = ''; }
    const hint = $('validate-file-hint');
    if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
    const errorBlock = $('error-warning-block');
    if (errorBlock) errorBlock.innerHTML = '';
    const detailsBlock = $('details-block');
    if (detailsBlock) detailsBlock.textContent = '';
    const pkg2DetailsBlock = $('pkg2-details-block');
    if (pkg2DetailsBlock) pkg2DetailsBlock.textContent = '';
    // Los <details> deben volver a plegarse en cada nueva selección — un
    // panel abierto a mano para el archivo anterior no debe heredarse
    // visualmente por el siguiente, aunque su contenido ya se actualice.
    const historicalDetails = $('validation-details');
    if (historicalDetails) historicalDetails.open = false;
    document.querySelectorAll('#package2-report details').forEach(details => { details.open = false; });
    lastState = null;
    lastPkg2State = null;
  }

  function init() {
    const input = $('file-input');
    if (!input) return;

    show('idle-message');
    hide('processing-message');
    hide('validation-report');

    input.addEventListener('change', async event => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;

      // El reinicio es siempre lo primero que ocurre, antes de tocar
      // cualquier lógica de detección — así una segunda o tercera
      // selección nunca hereda nada visible de la anterior.
      resetValidateState();

      // BETA-01 — detección de formato ANTES de cualquier otra cosa.
      // Si es Package Format 2.0, se desvía a la ruta de cuatro ejes y se
      // sale sin tocar ni un ápice del código histórico que sigue debajo.
      // Cualquier otro caso (ptc-distribution v1.0, TXT/MD/PDF/DOCX, ZIP
      // no reconocido) cae exactamente en el comportamiento de siempre.
      const ext = typeof PTCAdapters !== 'undefined' ? PTCAdapters.extensionOf(file.name) : '';
      if (ext === 'zip' && typeof PTCValidatePackage2 !== 'undefined' && typeof JSZip !== 'undefined') {
        try {
          const zip = await JSZip.loadAsync(await file.arrayBuffer());
          const detected = await PTCValidatePackage2.detectFormat(zip);
          if (detected.family === 'package2') {
            show('processing-message');
            const processing = $('processing-message');
            if (processing) processing.textContent = t('validate.processing', 'Verificando…');
            const state = await PTCValidatePackage2.validatePackage2(file);
            hide('processing-message');
            lastPkg2State = state;
            PTCValidatePackage2.render(state);
            focusResult('package2-report');
            showResultLimitNote();
            return;
          }
          // No es 2.0: mostrar el banner de formato correspondiente y
          // continuar hacia el camino histórico sin ninguna otra alteración.
          const banner = $('format-detected-banner');
          if (detected.family === 'unknown') {
            // BETA-02 — un ZIP que no es Package 2.0 ni v1.0 no es un error
            // de extracción confuso: es, sencillamente, un ZIP que no
            // contiene un paquete PTC reconocido. Mensaje claro y salida
            // directa hacia Crear, sin caer en el camino histórico (que
            // asumía que todo ZIP debía contener canonical/document_with_ptc.txt).
            show('ordinary-zip-message');
            return;
          }
          if (banner) {
            banner.style.display = 'block';
            banner.textContent = detected.family === 'legacy-v1'
              ? t('validate.format.legacy', 'Formato detectado: distribución PTC v1.0 compatible')
              : t('validate.format.unknown', 'Formato no reconocido automáticamente');
          }
        } catch (_) {
          // Cualquier fallo en la detección temprana no debe impedir el
          // camino histórico: se continúa exactamente como antes.
        }
      } else {
        const banner = $('format-detected-banner');
        if (banner) {
          if (['txt', 'md', 'pdf', 'docx'].includes(ext)) {
            banner.style.display = 'block';
            banner.textContent = t('validate.format.textual', 'Formato detectado: registro PTC textual');
          } else {
            banner.style.display = 'none';
          }
        }
      }

      const hint = $('validate-file-hint');
      if (hint) {
        const hintExt = typeof PTCAdapters !== 'undefined' ? PTCAdapters.extensionOf(file.name) : String(file.name || '').split('.').pop().toLowerCase();
        let message = '';
        let bg = 'var(--surface-alt)', border = 'var(--border)', color = 'var(--ink-muted)';
        if (hintExt === 'zip') {
          message = t('validate.hint.zip', '📦 Distribución histórica detectada. Se validará el artefacto canónico y se comprobará la coherencia de las piezas disponibles.');
          bg = 'var(--green-bg)'; border = 'var(--green-border)'; color = 'var(--green)';
        } else if (hintExt === 'txt') {
          message = t('validate.hint.txt', '✓ TXT canónico. Verificación directa y reproducible.');
        } else if (hintExt === 'md') {
          message = t('validate.hint.md', '✓ Markdown tratado como texto UTF-8. Se conserva su sintaxis como parte del contenido certificado.');
        } else if (hintExt === 'pdf') {
          message = t('validate.hint.pdf', '⚠️ PDF experimental. Para una verificación más sólida utiliza el paquete PTC o el TXT canónico.');
          bg = '#fff7ed'; border = '#fcd34d'; color = '#92400e';
        } else if (hintExt === 'docx') {
          message = t('validate.hint.docx', '⚠️ DOCX experimental. Validator reconstruirá el bloque PTC desde los párrafos finales. Para máxima reproducibilidad usa el paquete PTC.');
          bg = '#fff7ed'; border = '#fcd34d'; color = '#92400e';
        }
        if (message) {
          hint.textContent = message;
          hint.style.cssText = `display:block;background:${bg};border:1px solid ${border};color:${color};margin-top:.5rem;padding:.5rem .75rem;border-radius:6px;font-size:.83rem;`;
        } else {
          hint.style.display = 'none';
        }
      }

      onFileSelected(file);
    });

    window.addEventListener('i18n:changed', () => {
      if (lastState && $('validation-report') && $('validation-report').style.display !== 'none') renderReport(lastState);
      if (lastPkg2State && $('package2-report') && $('package2-report').style.display !== 'none' && typeof PTCValidatePackage2 !== 'undefined') {
        PTCValidatePackage2.render(lastPkg2State);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => waitForI18n(init));
  else waitForI18n(init);
})();

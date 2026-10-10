const GeneratorApp = (() => {
  let formData = {};
  let documentText = '';
  let hashScope = 'document_without_ptc_normalized';
  let sourceContext = null;
  let selectedFile = null;
  let fileGenerationPending = false;
  let referenceGenerationPending = false;
  let exactFileGenerationPending = false;
  let generationEpoch = 0;
  // U02 — activeGenerationMode reemplaza al antiguo currentInputMode binario.
  // Valores permitidos: 'document-content' | 'exact-file' | 'official-reference'.
  // selectedFile es compartido entre document-content y exact-file: cambiar de
  // puerta NUNCA lo borra (regla 3 de U02); solo cambia cómo se interpreta.
  let activeGenerationMode = 'document-content';
  let currentInputMode = 'file'; // alias retrocompatible: 'file' == document-content, 'reference' == official-reference

  function t(key, fallback = '') {
    if (window.I18n && typeof window.I18n.t === 'function') return window.I18n.t(key, fallback || '');
    return fallback || key;
  }

  function interpolate(template, values) {
    return String(template || '').replace(/\{([a-z_]+)\}/gi, (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
    );
  }

  function currentLocale() {
    const lang = (window.I18n && I18n.getCurrentLang) ? I18n.getCurrentLang() : document.documentElement.lang;
    return ({ es: 'es-ES', en: 'en-GB', fr: 'fr-FR' })[lang] || lang || 'es-ES';
  }

  function formatFileSize(bytes) {
    try {
      return new Intl.NumberFormat(currentLocale(), {
        style: 'unit', unit: 'byte', unitDisplay: 'short', maximumFractionDigits: 0
      }).format(bytes);
    } catch (_) {
      return `${Number(bytes).toLocaleString(currentLocale())} B`;
    }
  }

  function fileExtension(file) {
    const name = file && typeof file.name === 'string' ? file.name : '';
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function isSupportedFile(file) {
    return ['txt', 'md', 'pdf', 'docx'].includes(fileExtension(file));
  }

  function isFormReadyWithoutMutation() {
    const requiredIds = ['operator', 'level', 'ai-system', 'co-creation-mode', 'human-review', 'purpose', 'date-utc'];
    if (!requiredIds.every(id => {
      const el = document.getElementById(id);
      return !!(el && el.value);
    })) return false;
    const levelEl = document.getElementById('level');
    const otherDetailEl = document.getElementById('level-other-detail');
    if (levelEl && levelEl.value === 'other' && !(otherDetailEl && otherDetailEl.value.trim())) return false;

    return FREE_TEXT_FIELDS.every(id => {
      const el = document.getElementById(id);
      const raw = el ? (el.value || '') : '';
      return !raw.includes('|') && (!raw || !hasNonConformantEdge(raw));
    });
  }

  function isReferenceReadyWithoutMutation() {
    const refCsv = document.getElementById('ref-csv');
    const refUrl = document.getElementById('ref-url');
    const trimEdge = value => (typeof PTCCore !== 'undefined' && PTCCore.trimAsciiEdge)
      ? PTCCore.trimAsciiEdge(value)
      : String(value || '').trim();
    return currentInputMode === 'reference' && isFormReadyWithoutMutation() && refCsv && refUrl &&
      !!trimEdge(refCsv.value) && !!trimEdge(refUrl.value);
  }

  function updateReferenceGenerateButton() {
    const button = document.getElementById('generate-reference-btn');
    const status = document.getElementById('reference-generation-status');
    const error = document.getElementById('reference-generation-error');
    const ready = isReferenceReadyWithoutMutation();
    const statusVisible = !!(referenceGenerationPending && status && status.textContent);
    const errorVisible = !!(error && !error.hidden && error.textContent);
    if (!button) return;
    if (referenceGenerationPending) {
      button.disabled = false;
      button.setAttribute('aria-disabled', 'true');
    } else {
      button.disabled = !ready;
      button.removeAttribute('aria-disabled');
    }
    const describedBy = statusVisible
      ? 'reference-generation-status'
      : errorVisible
        ? 'reference-generation-error'
        : '';
    if (describedBy) button.setAttribute('aria-describedby', describedBy);
    else button.removeAttribute('aria-describedby');
  }

  // --------------------------------------------------
  // File extraction — shared adapters
  // --------------------------------------------------
  async function extractTextFromFile(file) {
    if (typeof PTCAdapters === 'undefined') throw new Error('PTCAdapters not loaded');
    return await PTCAdapters.extractSource(file);
  }

  // --------------------------------------------------
  // Form validation
  // --------------------------------------------------
  // B — no se transforma en silencio ningún valor normativo. Se detecta
  // un borde no conforme (espacio o tabulación ASCII al principio o al
  // final) y se bloquea la generación con un mensaje específico, para
  // que el usuario decida y corrija — el sistema no decide por él.
  function hasNonConformantEdge(raw) {
    return raw !== PTCCore.trimAsciiEdge(raw);
  }

  const FREE_TEXT_FIELDS = ['operator', 'ai-system', 'co-creation-mode', 'level-other-detail', 'purpose', 'doi', 'orcid'];

  function fieldLabel(id) {
    const map = {
      operator: ['generate.step1.q1.label', 'Operator'],
      'ai-system': ['generate.step1.q3.label', 'AI system or systems'],
      'co-creation-mode': ['generate.step1.q4.label', 'Form of collaboration'],
      'level-other-detail': ['generate.step1.q2.other_detail_label', 'Other participation case'],
      purpose: ['generate.step1.q6.label', 'Purpose and process context'],
      doi: ['generate.step1.q8.label', 'DOI'],
      orcid: ['generate.step1.q9.label', 'ORCID']
    };
    const item = map[id] || [id, id];
    return t(item[0], item[1]);
  }

  function setFieldError(el, message) {
    if (!el) return;
    const id = `${el.id}-error`;
    let error = document.getElementById(id);
    if (!error) {
      error = document.createElement('p');
      error.id = id;
      error.className = 'field-error';
      error.setAttribute('role', 'alert');
      el.insertAdjacentElement('afterend', error);
    }
    error.textContent = message || '';
    error.hidden = !message;
    el.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) el.setAttribute('aria-describedby', id);
    else if (el.getAttribute('aria-describedby') === id) el.removeAttribute('aria-describedby');
  }

  function validateFreeTextFields({ notify = false, checkEdges = false } = {}) {
    const pipeIssues = [];
    const edgeIssues = [];

    FREE_TEXT_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const raw = el.value || '';
      let message = '';
      if (raw.includes('|')) {
        message = t('generate.error.forbidden_pipe', 'The | character is not allowed in this field. Separate items with semicolons.');
        pipeIssues.push(fieldLabel(id));
      } else if (checkEdges && raw && hasNonConformantEdge(raw)) {
        message = t('generate.error.edge_whitespace', 'This field has a leading or trailing ASCII space or tab and must be corrected: ') + fieldLabel(id);
        edgeIssues.push(fieldLabel(id));
      }
      setFieldError(el, message);
    });

    return pipeIssues.length === 0 && edgeIssues.length === 0;
  }

  function validateForm({ notify = false, checkEdges = false } = {}) {
    const operatorRaw   = document.getElementById('operator').value;
    const level        = document.getElementById('level').value;
    const aiSystemRaw  = document.getElementById('ai-system').value;
    const modeRaw      = document.getElementById('co-creation-mode').value;
    const humanReview  = document.getElementById('human-review').value;
    const purposeRaw   = document.getElementById('purpose').value;
    const otherLevelRaw = document.getElementById('level-other-detail')?.value || '';
    const orcidRaw     = document.getElementById('orcid').value;
    const doiRaw       = document.getElementById('doi').value;
    const dateUtcRaw   = document.getElementById('date-utc').value;

    const freeTextValid = validateFreeTextFields({ notify, checkEdges });
    if (!dateUtcRaw || !operatorRaw || !level || !aiSystemRaw || !modeRaw || !humanReview || !purposeRaw || !freeTextValid) return false;
    if (level === 'other' && !otherLevelRaw.trim()) return false;

    const dateUtc = dateUtcRaw.length === 10
      ? dateUtcRaw + 'T' + new Date().toISOString().slice(11,19) + 'Z'
      : dateUtcRaw.endsWith('Z') ? dateUtcRaw : dateUtcRaw + 'Z';

    formData = {
      operator: operatorRaw,
      level,
      ai_system: aiSystemRaw,
      co_creation_mode: modeRaw,
      human_review: humanReview,
      purpose: level === 'other' ? `${otherLevelRaw.trim()} — ${purposeRaw}` : purposeRaw,
      date_utc: dateUtc,
      orcid: orcidRaw,
      doi: doiRaw
    };
    return true;
  }

  // --------------------------------------------------
  // PTC generation
  // --------------------------------------------------
  async function generatePTC() {
    // Núcleo único (PTCCore) — D7/D9/D10. generate.js ya no tiene
    // implementación propia de normalización, serialización ni hashes.
    const normalizedDoc = PTCCore.normalizeText(documentText);
    const hashDoc = await PTCCore.computeHashDoc(normalizedDoc);

    const fields = {
      version:          'R-01',
      level:            formData.level,
      operator:         formData.operator,
      date_utc:         formData.date_utc,
      ai_system:        formData.ai_system,
      co_creation_mode: formData.co_creation_mode,
      human_review:     formData.human_review,
      purpose:          formData.purpose,
      hash_scope:       hashScope,
      hash_doc_sha256:  hashDoc
    };

    // D1 — fórmula única del hash ético (consolidada en PTCCore).
    const ethicalHash = await PTCCore.computeEthicalContextHash(fields);
    fields.hash_ethical_context_sha256 = ethicalHash;

    if (formData.doi)   fields.doi   = formData.doi;
    if (formData.orcid) fields.orcid = formData.orcid;

    // D9 — serializePTC aplica la gramática de continuación (2 espacios)
    // si purpose es multilínea. computeHashPTC excluye internamente la
    // línea hash_ptc_sha256 de la preimagen (D2b).
    const ptcWithoutHashPTC = PTCCore.serializePTC(fields);
    const hashPTC = await PTCCore.computeHashPTC(ptcWithoutHashPTC);
    fields.hash_ptc_sha256 = hashPTC;

    const finalPTC = PTCCore.serializePTC(fields);
    // Autovalidación obligatoria — ningún artefacto sale del generador
    // sin haber pasado por el mismo núcleo que lo verificará después.
    // Esto cierra, sin duplicar reglas, cualquier caso donde el generador
    // pudiera producir algo que el propio validador luego rechazaría
    // (p. ej. un «|» en un campo ético, o una fecha inválida).
    const selfCheckArtifact = normalizedDoc + finalPTC;
    const selfCheck = await PTCCore.validate(selfCheckArtifact);
    if (selfCheck.status !== 'valid') {
      throw new Error(
        t('generate.error.self_validation', 'The generated declaration did not pass self-validation: ') + selfCheck.errors.join(', ')
      );
    }

    return {
      ptc: finalPTC, normalizedDoc, fields,
      hashScope,
      mode: hashScope === 'reference_csv_url_normalized' ? 'reference' : 'content',
      source: sourceContext ? { ...sourceContext } : null
    };
  }

  // --------------------------------------------------
  // Display
  // --------------------------------------------------
  function displayResults(result) {
    const step2 = document.getElementById('step-2');
    if (step2) {
      step2.style.display = 'block';
      step2.scrollIntoView({ behavior: 'smooth' });
    }

    const ptcOutput = document.getElementById('ptc-output');
    if (ptcOutput) ptcOutput.textContent = result.ptc;

    const copyBtn = document.getElementById('copy-ptc-btn');
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(result.ptc);
        alert(t('generate.step2.copied', 'PTC copied to clipboard!'));
      };
    }

    const dlBtn = document.getElementById('download-zip-btn');
    if (dlBtn) {
      dlBtn.onclick = async () => await createAndDownloadZIP(result);
    }
  }

  async function createAndDownloadZIP(result) {
    if (typeof PTCDistributionPackage === 'undefined') {
      alert('PTCDistributionPackage not loaded');
      return;
    }

    const language = (window.I18n && I18n.getCurrentLang) ? I18n.getCurrentLang() : 'en';
    const built = await PTCDistributionPackage.build(result, {
      type: 'blob',
      language,
      onRepresentationError: (format, error) => console.warn(`${format} representation omitted:`, error)
    });

    const url = URL.createObjectURL(built.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = built.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // --------------------------------------------------
  // DEV-UI01-U01 — local file selection state
  // --------------------------------------------------
  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setDynamicTranslation(id, key, fallback) {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute('data-i18n', key);
    el.textContent = t(key, fallback);
  }

  function announceFileStatus(message) {
    setText('file-picker-status', message);
  }

  function clearGenerationFeedback() {
    const error = document.getElementById('generation-error');
    const status = document.getElementById('generation-status');
    if (error) { error.textContent = ''; error.hidden = true; }
    if (status) status.textContent = '';
  }

  function clearReferenceFeedback() {
    const error = document.getElementById('reference-generation-error');
    const status = document.getElementById('reference-generation-status');
    if (error) { error.textContent = ''; error.hidden = true; }
    if (status) status.textContent = '';
    updateReferenceGenerateButton();
  }

  function showGenerationError(message) {
    const error = document.getElementById('generation-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
    updateFileGenerateButton();
  }

  function showReferenceError(message) {
    const error = document.getElementById('reference-generation-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
    updateReferenceGenerateButton();
  }

  function hideGeneratedResult() {
    const result = document.getElementById('step-2');
    if (result) result.style.display = 'none';
    const output = document.getElementById('ptc-output');
    if (output) output.textContent = '';
    const copyButton = document.getElementById('copy-ptc-btn');
    const downloadButton = document.getElementById('download-zip-btn');
    if (copyButton) copyButton.onclick = null;
    if (downloadButton) downloadButton.onclick = null;
  }

  function renderPackagePreview(file) {
    const preview = document.getElementById('file-package-preview');
    const input = document.getElementById('file-input-generate');
    if (!preview) return;
    if (input) {
      input.removeAttribute('aria-invalid');
      if (input.getAttribute('aria-describedby') === 'file-package-preview') input.removeAttribute('aria-describedby');
    }
    preview.removeAttribute('role');
    if (!file) {
      preview.textContent = '';
      preview.style.display = 'none';
      return;
    }

    const ext = fileExtension(file);
    const messages = {
      zip:  ['generate.preview.zip',  '⚠️ Has seleccionado un paquete ya generado. Para validarlo, usa la página de Validación.'],
      txt:  ['generate.preview.txt',  '📦 Fuente original · TXT canónico sin PTC · TXT canónico con PTC · ptc.txt · manifest.json · README.txt'],
      md:   ['generate.preview.md',   '📦 Fuente Markdown original · TXT canónico sin PTC · TXT canónico con PTC · Markdown con PTC · ptc.txt · manifest.json · README.txt'],
      docx: ['generate.preview.docx', '📦 Fuente DOCX original · TXT canónico sin PTC · TXT canónico con PTC · representación DOCX derivada con PTC cuando supere la autovalidación · ptc.txt · manifest.json · README.txt'],
      pdf:  ['generate.preview.pdf',  '📦 Fuente PDF original · TXT canónico sin PTC · TXT canónico con PTC · ptc.txt · manifest.json · README.txt. La representación PDF con PTC no se genera en esta versión.']
    };
    const item = messages[ext] || ['generate.preview.other', 'Formato no soportado. Usa TXT, MD, DOCX o PDF.'];
    preview.textContent = t(item[0], item[1]);
    preview.style.display = 'block';
    if (!isSupportedFile(file)) {
      preview.setAttribute('role', 'alert');
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', 'file-package-preview');
      }
    }
  }

  // U02 — el picker de "Contenido de un documento" y el de "Archivo exacto"
  // comparten el mismo selectedFile (regla 3). Cada uno renderiza su propia
  // tarjeta porque viven en paneles distintos, pero ambos reflejan el mismo
  // archivo en memoria. Ninguno de los dos lo borra al no estar activo.
  function renderSelectedFile({ announce = false } = {}) {
    const picker = document.getElementById('file-picker');
    const card = document.getElementById('selected-file-card');
    const mimeRow = document.getElementById('selected-file-mime-row');
    const hasFile = !!selectedFile;

    if (picker) picker.setAttribute('data-state', hasFile ? 'selected' : 'empty');
    if (card) card.hidden = !hasFile;
    setDynamicTranslation(
      'file-picker-label',
      hasFile ? 'generate.file.change' : 'generate.file.select',
      hasFile ? 'Cambiar archivo' : 'Seleccionar archivo'
    );

    const incompatibleWarning = document.getElementById('file-incompatible-warning');
    if (!hasFile) {
      setText('selected-file-name', '');
      setText('selected-file-size', '');
      setText('selected-file-mime', '');
      if (mimeRow) mimeRow.hidden = true;
      renderPackagePreview(null);
      if (incompatibleWarning) { incompatibleWarning.hidden = true; incompatibleWarning.textContent = ''; }
    } else {
      const size = formatFileSize(selectedFile.size);
      const mime = selectedFile.type || '';
      setText('selected-file-name', selectedFile.name);
      setText('selected-file-size', size);
      setText('selected-file-mime', mime);
      setText('selected-file-mode', t('generate.step2.mode_file', 'Contenido de un documento'));
      if (mimeRow) mimeRow.hidden = !mime;
      renderPackagePreview(selectedFile);

      // Regla 6 — un archivo incompatible con "Contenido de un documento"
      // NO se elimina; se conserva y se avisa; solo se bloquea la generación
      // textual (updateFileGenerateButton ya excluye por isSupportedFile()).
      if (incompatibleWarning) {
        if (!isSupportedFile(selectedFile)) {
          incompatibleWarning.hidden = false;
          incompatibleWarning.textContent = t(
            'generate.step2.incompatible_warning',
            'Este archivo no es compatible con «Contenido de un documento» (formatos admitidos: TXT, MD, DOCX, PDF). El archivo se conserva; cambia a «Archivo exacto» o selecciona otro archivo.'
          );
        } else {
          incompatibleWarning.hidden = true;
          incompatibleWarning.textContent = '';
        }
      }

      if (announce) {
        const key = mime ? 'generate.file.announce_selected' : 'generate.file.announce_selected_no_mime';
        const fallback = mime
          ? 'Archivo seleccionado: {name}. Tamaño: {size}. Tipo MIME informado por el navegador: {mime}.'
          : 'Archivo seleccionado: {name}. Tamaño: {size}.';
        announceFileStatus(interpolate(t(key, fallback), { name: selectedFile.name, size, mime }));
      }
    }

    renderSelectedExactFile();
  }

  function renderSelectedExactFile() {
    const card = document.getElementById('selected-exact-file-card');
    const mimeRow = document.getElementById('selected-exact-file-mime-row');
    const hasFile = !!selectedFile;

    setDynamicTranslation(
      'exact-file-picker-label',
      hasFile ? 'generate.step2.exact_file_change' : 'generate.step2.exact_file_select',
      hasFile ? 'Cambiar archivo' : 'Seleccionar archivo'
    );

    if (card) card.hidden = !hasFile;
    if (!hasFile) {
      setText('selected-exact-file-name', '');
      setText('selected-exact-file-size', '');
      setText('selected-exact-file-mime', '');
      if (mimeRow) mimeRow.hidden = true;
      return;
    }
    const size = formatFileSize(selectedFile.size);
    const mime = selectedFile.type || '';
    setText('selected-exact-file-name', selectedFile.name);
    setText('selected-exact-file-size', size);
    setText('selected-exact-file-mime', mime);
    if (mimeRow) mimeRow.hidden = !mime;
  }

  function updateFileGenerateButton() {
    const button = document.getElementById('generate-ptc-button');
    const readyText = document.getElementById('generation-ready');
    const status = document.getElementById('generation-status');
    const error = document.getElementById('generation-error');
    const ready = activeGenerationMode === 'document-content' && !!selectedFile && isSupportedFile(selectedFile) &&
      isFormReadyWithoutMutation();
    const errorVisible = !!(error && !error.hidden && error.textContent);
    const statusVisible = !!(fileGenerationPending && status && status.textContent);

    if (button) {
      if (fileGenerationPending) {
        button.disabled = false;
        button.setAttribute('aria-disabled', 'true');
      } else {
        button.disabled = !ready;
        button.removeAttribute('aria-disabled');
      }
      const describedBy = statusVisible
        ? 'generation-status'
        : errorVisible
          ? 'generation-error'
          : ready
            ? 'generation-ready'
            : '';
      if (describedBy) button.setAttribute('aria-describedby', describedBy);
      else button.removeAttribute('aria-describedby');
    }
    if (readyText) readyText.hidden = !(ready && !fileGenerationPending && !errorVisible);
    return ready && !fileGenerationPending;
  }

  // BETA-01 — Archivo exacto ya genera de verdad (FRS-01 + Package 2.0,
  // con divulgación DCL-03 opcional). isDisclosureReadyWithoutMutation()
  // solo exige type y, si hay URL, que sea sintácticamente válida.
  function isValidVerificationUrl(raw) {
    if (!raw) return true; // opcional
    if (/\s/.test(raw)) return false;
    try {
      const u = new URL(raw);
      return u.protocol === 'https:';
    } catch (_) { return false; }
  }

  function isDisclosureReadyWithoutMutation() {
    const toggle = document.getElementById('exact-disclosure-toggle');
    if (!toggle || !toggle.checked) return true; // desactivado: no bloquea nada
    const type = document.getElementById('disclosure-type');
    const url = document.getElementById('disclosure-url');
    if (!type || !type.value) return false;
    return isValidVerificationUrl(url ? url.value : '');
  }

  function updateExactFileButton() {
    const button = document.getElementById('generate-exact-file-button');
    const readyText = document.getElementById('exact-file-generation-ready');
    const status = document.getElementById('exact-file-generation-status');
    const error = document.getElementById('exact-file-generation-error');
    const ready = activeGenerationMode === 'exact-file' && !!selectedFile &&
      isFormReadyWithoutMutation() && isDisclosureReadyWithoutMutation();
    const errorVisible = !!(error && !error.hidden && error.textContent);
    const statusVisible = !!(exactFileGenerationPending && status && status.textContent);
    if (button) {
      if (exactFileGenerationPending) {
        button.disabled = false;
        button.setAttribute('aria-disabled', 'true');
      } else {
        button.disabled = !ready;
        button.removeAttribute('aria-disabled');
      }
    }
    if (readyText) readyText.hidden = !(ready && !exactFileGenerationPending && !errorVisible);
    return ready && !exactFileGenerationPending;
  }

  function setExactFileProcessing(processing) {
    exactFileGenerationPending = processing;
    const control = document.getElementById('exact-file-generation-control');
    if (control) control.setAttribute('aria-busy', processing ? 'true' : 'false');
    setDynamicTranslation(
      'generate-exact-file-button-label',
      processing ? 'generate.action_busy' : 'generate.action',
      processing ? 'Procesando…' : 'Generar declaración PTC'
    );
    updateExactFileButton();
  }

  function showExactFileError(message) {
    const error = document.getElementById('exact-file-generation-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
    updateExactFileButton();
  }

  function clearExactFileFeedback() {
    const error = document.getElementById('exact-file-generation-error');
    const status = document.getElementById('exact-file-generation-status');
    if (error) { error.textContent = ''; error.hidden = true; }
    if (status) status.textContent = '';
  }

  function hideExactFileResult() {
    const result = document.getElementById('exact-file-step-2');
    if (result) result.style.display = 'none';
    const output = document.getElementById('exact-file-ptc-output');
    if (output) output.textContent = '';
    const dlBtn = document.getElementById('exact-file-download-zip-btn');
    if (dlBtn) dlBtn.onclick = null;
  }

  async function generateExactFilePTC() {
    const sourceSha256 = await PTCFileReference.computeSourceSha256(selectedFile);
    const sizeBytes = selectedFile.size;

    const disclosureToggle = document.getElementById('exact-disclosure-toggle');
    let disclosure = null;
    if (disclosureToggle && disclosureToggle.checked) {
      const type = document.getElementById('disclosure-type').value;
      const language = (window.I18n && I18n.getCurrentLang) ? I18n.getCurrentLang() : 'es';
      const urlRaw = document.getElementById('disclosure-url').value.trim();
      disclosure = { type, language, verificationUrl: urlRaw || undefined };
    }

    const canonicalObject = PTCFileReference.buildCanonicalObject({ sizeBytes, sourceSha256, disclosure });
    const hashDoc = await PTCCore.computeHashDoc(canonicalObject);

    const fields = {
      version: 'R-01',
      level: formData.level,
      operator: formData.operator,
      date_utc: formData.date_utc,
      ai_system: formData.ai_system,
      co_creation_mode: formData.co_creation_mode,
      human_review: formData.human_review,
      purpose: formData.purpose,
      hash_scope: 'document_without_ptc_normalized',
      hash_doc_sha256: hashDoc
    };
    const ethicalHash = await PTCCore.computeEthicalContextHash(fields);
    fields.hash_ethical_context_sha256 = ethicalHash;
    if (formData.doi) fields.doi = formData.doi;
    if (formData.orcid) fields.orcid = formData.orcid;

    const ptcWithoutHashPTC = PTCCore.serializePTC(fields);
    const hashPTC = await PTCCore.computeHashPTC(ptcWithoutHashPTC);
    fields.hash_ptc_sha256 = hashPTC;
    const finalPTC = PTCCore.serializePTC(fields);

    const selfCheckArtifact = canonicalObject + finalPTC;
    const selfCheck = await PTCCore.validate(selfCheckArtifact);
    if (selfCheck.status !== 'valid') {
      throw new Error(
        t('generate.error.self_validation', 'The generated declaration did not pass self-validation: ') + selfCheck.errors.join(', ')
      );
    }

    let qrFailed = false;
    const euKitToggle = document.getElementById('eu-kit-toggle');
    const includeEuKit = !!(euKitToggle && euKitToggle.checked);
    const euIconOverrideEl = document.getElementById('eu-icon-override');
    const euIconIdOverride = (euIconOverrideEl && euIconOverrideEl.value) || undefined;
    // Carga lazy de eu-icons.js solo si el usuario activó el material europeo
    if (includeEuKit && typeof window.loadEuIcons === 'function') {
      await new Promise((resolve, reject) => window.loadEuIcons(resolve, reject));
    }
    const pkg = await PTCPackage2.buildPackage({
      file: selectedFile, sizeBytes, sourceSha256,
      canonicalObject, ptcBlock: finalPTC, disclosure, includeEuKit, euIconIdOverride
    });
    if (disclosure && disclosure.verificationUrl && pkg.manifest.public_notice && !pkg.manifest.public_notice.qr_path) {
      qrFailed = true;
    }

    return { ptc: finalPTC, pkg, qrFailed };
  }

  function setFileProcessing(processing) {
    fileGenerationPending = processing;
    const control = document.getElementById('generation-control');
    if (control) control.setAttribute('aria-busy', processing ? 'true' : 'false');
    setDynamicTranslation(
      'generate-ptc-button-label',
      processing ? 'generate.action_busy' : 'generate.action',
      processing ? 'Procesando…' : 'Generar declaración PTC'
    );
    updateFileGenerateButton();
  }

  function setReferenceProcessing(processing) {
    referenceGenerationPending = processing;
    const control = document.getElementById('reference-generation-control');
    if (control) control.setAttribute('aria-busy', processing ? 'true' : 'false');
    setDynamicTranslation(
      'generate-reference-btn',
      processing ? 'generate.action_busy' : 'generate.step2.ref_generate',
      processing ? 'Procesando…' : 'Generar declaración PTC'
    );
    updateReferenceGenerateButton();
  }

  function invalidateActiveGeneration({ clearFeedback = true, hideResult = true } = {}) {
    generationEpoch += 1;
    if (clearFeedback) {
      clearGenerationFeedback();
      clearReferenceFeedback();
      clearExactFileFeedback();
    }
    setFileProcessing(false);
    setReferenceProcessing(false);
    setExactFileProcessing(false);
    if (hideResult) { hideGeneratedResult(); hideExactFileResult(); }
  }

  function selectFile(file) {
    if (!file) return;
    selectedFile = file;
    documentText = '';
    sourceContext = null;
    hashScope = 'document_without_ptc_normalized';
    invalidateActiveGeneration();
    renderSelectedFile({ announce: true });
    updateFileGenerateButton();
    updateExactFileButton();
  }

  function init() {
    initLevelSelector();

    const form      = document.getElementById('declaration-form');
    const fileInput = document.getElementById('file-input-generate');
    const step2     = document.getElementById('step-2');

    if (step2) step2.style.display = 'none';
    window.addEventListener('i18n:changed', () => {
      validateFreeTextFields({ notify: false, checkEdges: false });
      renderSelectedFile();
      setDynamicTranslation(
        'generate-ptc-button-label',
        fileGenerationPending ? 'generate.action_busy' : 'generate.action',
        fileGenerationPending ? 'Procesando…' : 'Generar declaración PTC'
      );
      setDynamicTranslation(
        'generate-reference-btn',
        referenceGenerationPending ? 'generate.action_busy' : 'generate.step2.ref_generate',
        referenceGenerationPending ? 'Procesando…' : 'Generar declaración PTC'
      );
      if (referenceGenerationPending) {
        setText('reference-generation-status', t(
          'generate.status_processing_reference',
          'Procesando la referencia y generando la declaración PTC…'
        ));
      }
      const referenceError = document.getElementById('reference-generation-error');
      if (referenceError && !referenceError.hidden) {
        referenceError.textContent = t(
          'generate.error_processing_reference',
          'No se pudo generar la declaración para esta referencia. La referencia y los datos del formulario se conservan. Puedes corregirlos o intentarlo de nuevo.'
        );
      }
      updateFileGenerateButton();
      updateReferenceGenerateButton();
    });


  // Level-aware UI. Levels are declarative categories, not a quality scale.
  function initLevelSelector() {
    const select = document.getElementById('level');
    const hint = document.getElementById('level-hint');
    const purpose = document.getElementById('purpose');
    const hints = {
      basic: () => t('generate.level_hints.basic', 'State the specific task or tasks performed by AI.'),
      standard: () => t('generate.level_hints.standard', 'Briefly describe how the collaboration developed and which decisions were made by the operator.'),
      extended: () => t('generate.level_hints.extended', 'Describe the relevant stages and how the process can be reconstructed or understood.'),
      other: () => t('generate.level_hints.other', 'Explain why the preceding levels do not adequately represent the case.')
    };
    const update = () => {
      const value = select ? select.value : '';
      if (hint) hint.textContent = value && hints[value] ? hints[value]() : '';
      if (purpose) purpose.closest('.form-group')?.classList.toggle('is-other-level', value === 'other');
      const otherWrap = document.getElementById('level-other-wrapper');
      const otherDetail = document.getElementById('level-other-detail');
      const showOther = value === 'other';
      if (otherWrap) otherWrap.hidden = !showOther;
      if (otherDetail) {
        otherDetail.required = showOther;
        if (!showOther) otherDetail.value = '';
      }
    };
    if (select) select.addEventListener('change', update);
    window.addEventListener('i18n:changed', update);
    update();
  }

    // UX-DATA-01: selector eliminado — ai-system es campo libre único

    // UX-DATA-01: selector eliminado — co-creation-mode es campo libre único

    if (form) {
      form.querySelectorAll('input, select, textarea').forEach(el => {
        el.addEventListener('input', () => {
          invalidateActiveGeneration();
          validateFreeTextFields({ notify: false, checkEdges: false });
          updateFileGenerateButton();
          updateExactFileButton();
        });
        el.addEventListener('change', () => {
          invalidateActiveGeneration();
          validateFreeTextFields({ notify: false, checkEdges: true });
          updateFileGenerateButton();
          updateExactFileButton();
        });
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', event => {
        const file = event.target.files && event.target.files[0];
        if (file) selectFile(file);
      });
    }

    // U02 — segundo input, mismo selectedFile compartido. Sin atributo
    // accept: FRS-01 admite cualquier secuencia de bytes (§14 de la orden;
    // "El atributo accept NO DEBE utilizarse para limitar de manera
    // normativa este modo").
    const exactFileInput = document.getElementById('file-input-exact');
    if (exactFileInput) {
      exactFileInput.addEventListener('change', event => {
        const file = event.target.files && event.target.files[0];
        if (file) selectFile(file);
      });
    }

    const removeFileBtn = document.getElementById('remove-file-button');
    if (removeFileBtn) removeFileBtn.addEventListener('click', () => removeSelectedFile({ focusInputId: 'main-dropzone-label' }));

    const removeExactFileBtn = document.getElementById('remove-exact-file-button');
    if (removeExactFileBtn) removeExactFileBtn.addEventListener('click', () => removeSelectedFile({ focusInputId: 'main-dropzone-label' }));

    // BETA-01 — aviso público opcional (DCL-03), subordinado a Archivo exacto.
    const disclosureToggle = document.getElementById('exact-disclosure-toggle');
    const disclosureFields = document.getElementById('exact-disclosure-fields');
    const disclosureUrl = document.getElementById('disclosure-url');
    const disclosureType = document.getElementById('disclosure-type');

    function updateDisclosureUrlError() {
      const err = document.getElementById('disclosure-url-error');
      if (!err || !disclosureUrl) return;
      const ok = isValidVerificationUrl(disclosureUrl.value.trim());
      err.hidden = ok;
      err.textContent = ok ? '' : t('generate.step2.disclosure_url_error', 'The URL must start with https:// and contain no spaces.');
      disclosureUrl.setAttribute('aria-invalid', ok ? 'false' : 'true');
    }

    if (disclosureToggle) {
      disclosureToggle.addEventListener('change', () => {
        if (disclosureFields) disclosureFields.hidden = !disclosureToggle.checked;
        invalidateActiveGeneration();
        updateExactFileButton();
      });
    }
    if (disclosureType) {
      disclosureType.addEventListener('change', () => { invalidateActiveGeneration(); updateExactFileButton(); });
    }
    if (disclosureUrl) {
      disclosureUrl.addEventListener('input', () => {
        invalidateActiveGeneration();
        updateDisclosureUrlError();
        updateExactFileButton();
      });
    }

    // §10 — puerta 1: "voy a publicar o compartir este contenido". Solo si
    // se activa aparece la puerta 2 (el interruptor de siempre). Desactivar
    // la puerta 1 colapsa todo lo de abajo, incluida la puerta 2 y sus
    // campos — nunca deja un estado a medias con la puerta 2 marcada pero
    // invisible.
    const disclosureGate1 = document.getElementById('disclosure-gate1-toggle');
    const disclosureGate2Wrapper = document.getElementById('disclosure-gate2-wrapper');
    if (disclosureGate1) {
      disclosureGate1.addEventListener('change', () => {
        if (disclosureGate1.checked) {
          if (disclosureGate2Wrapper) disclosureGate2Wrapper.hidden = false;
        } else {
          if (disclosureGate2Wrapper) disclosureGate2Wrapper.hidden = true;
          if (disclosureToggle) disclosureToggle.checked = false;
          if (disclosureFields) disclosureFields.hidden = true;
        }
        invalidateActiveGeneration();
        updateExactFileButton();
        if (typeof updateSummaryAndGenerateVisibility === 'function') updateSummaryAndGenerateVisibility();
      });
    }

    const generateExactFileBtn = document.getElementById('generate-exact-file-button');
    if (generateExactFileBtn) {
      generateExactFileBtn.addEventListener('click', async () => {
        if (exactFileGenerationPending || !selectedFile) return;
        hideExactFileResult();
        clearExactFileFeedback();
        if (!validateForm({ notify: true, checkEdges: true }) || !isDisclosureReadyWithoutMutation()) {
          updateDisclosureUrlError();
          showExactFileError(t('generate.error.complete_fields', 'Complete all required fields before generating the declaration.'));
          updateExactFileButton();
          return;
        }
        const file = selectedFile;
        const epoch = ++generationEpoch;
        setText('exact-file-generation-status', t('generate.status_processing', 'Procesando el archivo y generando la declaración PTC…'));
        setExactFileProcessing(true);
        let persistentStatus = '';
        try {
          const { ptc, pkg, qrFailed } = await generateExactFilePTC();
          if (epoch !== generationEpoch || selectedFile !== file || activeGenerationMode !== 'exact-file') return;
          const step2 = document.getElementById('exact-file-step-2');
          const output = document.getElementById('exact-file-ptc-output');
          if (step2) { step2.style.display = 'block'; step2.scrollIntoView({ behavior: 'smooth' }); }
          if (output) output.textContent = ptc;
          const dlBtn = document.getElementById('exact-file-download-zip-btn');
          if (dlBtn) {
            dlBtn.onclick = () => {
              const url = URL.createObjectURL(pkg.blob);
              const link = document.createElement('a');
              link.href = url; link.download = pkg.filename;
              document.body.appendChild(link); link.click(); document.body.removeChild(link);
              URL.revokeObjectURL(url);
            };
          }
          if (qrFailed) {
            persistentStatus = t('generate.error.qr_unavailable', 'The QR code could not be generated. The package is generated anyway, without qr.svg.');
          }
        } catch (err) {
          if (epoch !== generationEpoch || selectedFile !== file || activeGenerationMode !== 'exact-file') return;
          showExactFileError(t('generate.error_processing', 'No se pudo procesar el archivo. El archivo y los datos del formulario se conservan. Puedes intentarlo de nuevo, cambiar el archivo o retirarlo.'));
          console.error(err);
        } finally {
          if (epoch === generationEpoch) {
            setText('exact-file-generation-status', persistentStatus);
            setExactFileProcessing(false);
          }
        }
      });
    }

    const generateFileBtn = document.getElementById('generate-ptc-button');
    if (generateFileBtn) {
      generateFileBtn.addEventListener('click', async () => {
        if (fileGenerationPending || !selectedFile || !isSupportedFile(selectedFile)) return;
        hideGeneratedResult();
        clearGenerationFeedback();
        if (!validateForm({ notify: true, checkEdges: true })) {
          showGenerationError(t('generate.error.complete_fields', 'Complete all required fields before generating the declaration.'));
          updateFileGenerateButton();
          return;
        }

        const file = selectedFile;
        const epoch = ++generationEpoch;
        setText('generation-status', t(
          'generate.status_processing',
          'Procesando el archivo y generando la declaración PTC…'
        ));
        setFileProcessing(true);

        try {
          const extracted = await extractTextFromFile(file);
          if (epoch !== generationEpoch || selectedFile !== file || currentInputMode !== 'file') return;

          documentText = extracted.text;
          sourceContext = {
            file,
            ext: extracted.ext,
            adapter: extracted.adapter,
            experimental: !!extracted.experimental
          };
          hashScope = 'document_without_ptc_normalized';
          const result = await generatePTC();
          if (epoch !== generationEpoch || selectedFile !== file || currentInputMode !== 'file') return;
          displayResults(result);
        } catch (_) {
          if (epoch !== generationEpoch || selectedFile !== file || currentInputMode !== 'file') return;
          setText('generation-status', '');
          showGenerationError(t(
            'generate.error_processing',
            'No se pudo procesar el archivo. El archivo y los datos del formulario se conservan. Puedes intentarlo de nuevo, cambiar el archivo o retirarlo.'
          ));
        } finally {
          if (epoch === generationEpoch) {
            setText('generation-status', '');
            setFileProcessing(false);
          }
        }
      });
    }

    renderSelectedFile();
    updateFileGenerateButton();
    updateExactFileButton();

    // ── U02 — Tres puertas de entrada ──
    // Mismo formulario de declaración compartido (regla 2). selectedFile
    // compartido entre document-content y exact-file (regla 3). Ningún
    // cambio de puerta borra CSV/URL: viven en el DOM, oculto ≠ destruido
    // (reglas 8 y 9). "Solo una puerta activa" (regla 1) se cumple porque
    // setActiveMode es la única función que decide visibilidad de panel.
    const doors = [
      { mode: 'document-content',   tabId: 'mode-file',       panelId: 'input-file' },
      { mode: 'exact-file',         tabId: 'mode-exact-file', panelId: 'input-exact-file' },
      { mode: 'official-reference', tabId: 'mode-reference',  panelId: 'input-reference' }
    ];
    const refCsv = document.getElementById('ref-csv');
    const refUrl = document.getElementById('ref-url');
    const refBtn = document.getElementById('generate-reference-btn');

    function setActiveMode(mode, { focusTab = false } = {}) {
      if (!doors.some(d => d.mode === mode)) return;
      const changed = activeGenerationMode !== mode;
      activeGenerationMode = mode;
      // Alias retrocompatible para la lógica de generación ya existente
      // (isReferenceReadyWithoutMutation, hashScope de Documento/Referencia).
      // 'exact-file' no participa todavía en ninguna ruta de generación: se
      // usa un valor neutro que ninguna comprobación de listeza reconoce.
      currentInputMode = mode === 'official-reference' ? 'reference'
        : mode === 'document-content' ? 'file'
        : 'exact';
      if (changed) invalidateActiveGeneration();
      hashScope = mode === 'official-reference' ? 'reference_csv_url_normalized' : 'document_without_ptc_normalized';

      doors.forEach(d => {
        const tab = document.getElementById(d.tabId);
        const panel = document.getElementById(d.panelId);
        const isActive = d.mode === mode;
        if (panel) panel.style.display = isActive ? 'block' : 'none';
        if (tab) {
          tab.classList.toggle('active', isActive);
          tab.setAttribute('aria-selected', String(isActive));
          tab.tabIndex = isActive ? 0 : -1;
          if (isActive && focusTab) tab.focus();
        }
      });

      updateFileGenerateButton();
      updateExactFileButton();
      updateReferenceGenerateButton();
    }

    doors.forEach(d => {
      const tab = document.getElementById(d.tabId);
      if (tab) tab.addEventListener('click', () => setActiveMode(d.mode));
    });

    // Navegación de teclado del tablist (patrón de activación automática:
    // ← → mueven el foco Y activan la puerta; Inicio/Fin van a los
    // extremos; Enter/Espacio activan la puerta con el foco, redundante con
    // la activación automática pero exigido explícitamente por U02).
    const tabsContainer = document.getElementById('mode-tabs');
    if (tabsContainer) {
      tabsContainer.addEventListener('keydown', event => {
        const tabs = doors.map(d => document.getElementById(d.tabId)).filter(Boolean);
        const currentIndex = tabs.indexOf(document.activeElement);
        if (currentIndex === -1) return;
        let targetIndex = null;
        if (event.key === 'ArrowRight') targetIndex = (currentIndex + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') targetIndex = 0;
        else if (event.key === 'End') targetIndex = tabs.length - 1;
        else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setActiveMode(doors[currentIndex].mode, { focusTab: true });
          return;
        }
        if (targetIndex !== null) {
          event.preventDefault();
          setActiveMode(doors[targetIndex].mode, { focusTab: true });
        }
      });
    }

    if (form) form.querySelectorAll('input, select, textarea').forEach(el => {
      el.addEventListener('input', updateReferenceGenerateButton);
      el.addEventListener('change', updateReferenceGenerateButton);
    });
    [refCsv, refUrl].forEach(field => {
      if (!field) return;
      const invalidateReferenceInput = () => {
        invalidateActiveGeneration();
        updateReferenceGenerateButton();
      };
      field.addEventListener('input', invalidateReferenceInput);
      field.addEventListener('change', invalidateReferenceInput);
    });

    if (refBtn) {
      refBtn.addEventListener('click', async () => {
        if (referenceGenerationPending) return;
        hideGeneratedResult();
        clearReferenceFeedback();
        if (typeof PTCCore === 'undefined') { alert('PTCCore no cargado'); return; }
        if (!validateForm({ notify: true, checkEdges: true }) || !isReferenceReadyWithoutMutation()) { const visibleError = document.querySelector('.field-error:not([hidden])'); alert(visibleError ? visibleError.textContent : t('generate.error.complete_fields', 'Complete all required fields before generating the declaration.')); return; }
        const epoch = ++generationEpoch;
        setText('reference-generation-status', t(
          'generate.status_processing_reference',
          'Procesando la referencia y generando la declaración PTC…'
        ));
        setReferenceProcessing(true);
        try {
          sourceContext = null;
          documentText = PTCCore.buildReferenceBody(refCsv.value, refUrl.value);
          hashScope = 'reference_csv_url_normalized';
          const result = await generatePTC();
          if (epoch !== generationEpoch || currentInputMode !== 'reference') return;
          displayResults(result);
        } catch (error) {
          if (epoch !== generationEpoch || currentInputMode !== 'reference') return;
          setText('reference-generation-status', '');
          showReferenceError(t(
            'generate.error_processing_reference',
            'No se pudo generar la declaración para esta referencia. La referencia y los datos del formulario se conservan. Puedes corregirlos o intentarlo de nuevo.'
          ));
          console.error(error);
        } finally {
          if (epoch === generationEpoch) {
            setText('reference-generation-status', '');
            setReferenceProcessing(false);
          }
        }
      });
    }
    // Estado inicial consistente: no confiar solo en los atributos escritos
    // a mano del HTML — fijarlo explícitamente desde el mismo código que
    // gestionará todos los cambios posteriores.
    // BETA-02: "Archivo exacto" es ahora el recorrido predeterminado, no
    // "Contenido de un documento" (decisión de diseño explícita, UI-01 v0.3).
    setActiveMode('exact-file');
    updateReferenceGenerateButton();

    // ══════════════════════════════════════════════════════════════════
    // BETA-02 — máquina de etapas de la nueva pantalla de Crear.
    // No reemplaza la lógica ya probada (selectFile, generateExactFilePTC,
    // setActiveMode, validación de formulario): la reviste y la conduce.
    // ══════════════════════════════════════════════════════════════════
    const STAGES = ['initial', 'reference', 'file'];
    function showStage(stage) {
      STAGES.forEach(s => {
        const el = document.getElementById(`stage-${s}`);
        if (el) el.style.display = (s === stage) ? 'block' : 'none';
      });
    }

    function removeSelectedFile({ returnFocus = true, focusInputId = 'main-dropzone-label' } = {}) {
      selectedFile = null;
      documentText = '';
      sourceContext = null;
      hashScope = 'document_without_ptc_normalized';

      // Ambos inputs comparten selectedFile; retirar limpia los dos, para que
      // volver a elegir el mismo archivo en cualquiera de las dos puertas
      // dispare de nuevo el evento 'change' del navegador.
      ['file-input-generate', 'file-input-exact'].forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        input.value = '';
        const zone = input.closest('.drop-zone');
        if (zone) zone.classList.remove('has-file');
      });
      invalidateActiveGeneration();
      renderSelectedFile();
      updateFileGenerateButton();
      updateExactFileButton();
      announceFileStatus(t('generate.file.announce_removed', 'Archivo retirado.'));

      // BETA-02.1 — corrección del recorrido bloqueado: retirar el archivo
      // debe devolver la interfaz por completo al estado inicial, no dejar
      // el formulario visible ni el selector inicial oculto. Reutilizado
      // también por "Cambiar archivo" y por "Volver" desde Referencia.
      resetGenerateFlowToInitial();

      if (returnFocus) {
        const focusTarget = document.getElementById(focusInputId);
        if (focusTarget) focusTarget.focus();
      }
    }

    // Reinicio completo del recorrido de Crear: limpia formulario, aviso
    // público, kit europeo y referencia, oculta todo lo revelado
    // progresivamente, y vuelve a la pantalla inicial. Se llama siempre que
    // el usuario abandona un archivo o una referencia ya empezados, para que
    // una declaración iniciada para un documento nunca se reutilice sin
    // querer con otro (regla explícita del encargo).
    function resetGenerateFlowToInitial() {
      if (form) {
        form.reset();
        form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
        form.querySelectorAll('.field-error').forEach(el => { el.hidden = true; el.textContent = ''; });
      }
      const disclosureToggleEl = document.getElementById('exact-disclosure-toggle');
      if (disclosureToggleEl) disclosureToggleEl.checked = false;
      const disclosureFieldsEl = document.getElementById('exact-disclosure-fields');
      if (disclosureFieldsEl) disclosureFieldsEl.hidden = true;
      const disclosureGate1El = document.getElementById('disclosure-gate1-toggle');
      if (disclosureGate1El) disclosureGate1El.checked = false;
      const disclosureGate2WrapperEl = document.getElementById('disclosure-gate2-wrapper');
      if (disclosureGate2WrapperEl) disclosureGate2WrapperEl.hidden = true;
      const euKitToggleEl = document.getElementById('eu-kit-toggle');
      if (euKitToggleEl) euKitToggleEl.checked = false;
      const euKitPreviewEl = document.getElementById('eu-kit-preview');
      if (euKitPreviewEl) euKitPreviewEl.hidden = true;
      const disclosureUrlErr = document.getElementById('disclosure-url-error');
      if (disclosureUrlErr) disclosureUrlErr.hidden = true;

      const refCsvEl = document.getElementById('ref-csv');
      if (refCsvEl) refCsvEl.value = '';
      const refUrlEl = document.getElementById('ref-url');
      if (refUrlEl) refUrlEl.value = '';

      // Residuos señalados en la revisión independiente de U1:
      // limpiar la pista dinámica del nivel «Otro» y su clase asociada,
      // y cerrar cualquier <details> que hubiera quedado abierto.
      const levelHintEl = document.getElementById('level-hint');
      if (levelHintEl) levelHintEl.textContent = '';
      const levelOtherEl = document.getElementById('level-other-detail');
      if (levelOtherEl) levelOtherEl.value = '';
      const levelOtherWrap = document.getElementById('level-other-wrapper');
      if (levelOtherWrap) levelOtherWrap.hidden = true;
      const purposeGroup = document.getElementById('purpose')?.closest('.form-group');
      if (purposeGroup) purposeGroup.classList.remove('is-other-level');
      document.querySelectorAll('details[open]').forEach(d => { d.open = false; });
      document.querySelectorAll('.info-panel:not([hidden])').forEach(p => {
        p.hidden = true;
        const btn = document.querySelector(`[aria-controls="${p.id}"]`);
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });

      ['questions-intro', 'mode-selector-wrapper',
       'disclosure-block', 'summary-section', 'exact-file-generation-action', 'generation-action']
        .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
      hideExactFileResult();
      hideGeneratedResult();

      const declStep = document.getElementById('declaration-step');
      if (declStep) declStep.style.display = 'none';

      setActiveMode('exact-file');
      showStage('initial');
    }


    const goToReferenceBtn = document.getElementById('go-to-reference-btn');
    const backFromReferenceBtn = document.getElementById('back-from-reference-btn');
    if (goToReferenceBtn) {
      goToReferenceBtn.addEventListener('click', () => {
        showStage('reference');
        setActiveMode('official-reference');
        // La referencia también necesita el formulario PTC compartido —
        // el mismo fallo que la selección de archivo revela mediante
        // revealFileStageProgressively(), aquí de forma más simple porque
        // la referencia no tiene modo textual/exacto que decidir.
        document.getElementById('declaration-step').style.display = 'block';
        const csv = document.getElementById('ref-csv');
        if (csv) csv.focus();
      });
    }
    if (backFromReferenceBtn) {
      backFromReferenceBtn.addEventListener('click', () => {
        // Corrección: "Volver" dejaba el formulario compartido visible,
        // porque es hermano —no hijo— de las etapas y nada lo ocultaba
        // explícitamente. resetGenerateFlowToInitial() lo cubre junto con
        // CSV/URL y el resto del estado, de una sola vez.
        resetGenerateFlowToInitial();
        const dz = document.getElementById('main-dropzone-label');
        if (dz) dz.focus();
      });
    }
    const changeFileBtn = document.getElementById('change-file-btn');
    if (changeFileBtn) {
      changeFileBtn.addEventListener('click', () => {
        removeSelectedFile({ returnFocus: true, focusInputId: 'main-dropzone-label' });
      });
    }

    // El input físico #file-input-exact es ahora la única entrada visible
    // de la pantalla inicial (regla 2 del encargo: entrada única mediante
    // archivo). Seleccionar un archivo ahí conduce directamente a la etapa
    // "file" con el modo "exact-file" ya activo (regla 3: predeterminado).
    const mainInput = document.getElementById('file-input-exact');
    if (mainInput) {
      mainInput.addEventListener('change', () => {
        if (!selectedFile) return; // el listener original ya rellenó selectedFile
        showStage('file');
        setActiveMode('exact-file');
        revealFileStageProgressively();
      });
    }

    function updateModeSelector() {
      const exactBtn = document.getElementById('mode-select-exact');
      const textualBtn = document.getElementById('mode-select-textual');
      const indicatorTitle = document.getElementById('mode-indicator-title');
      const indicatorText = document.getElementById('mode-indicator-text');
      if (!exactBtn || !textualBtn) return;

      const compatible = isSupportedFile(selectedFile);
      const isExact = activeGenerationMode === 'exact-file';

      exactBtn.classList.toggle('is-active', isExact);
      exactBtn.setAttribute('aria-pressed', String(isExact));
      textualBtn.classList.toggle('is-active', !isExact && compatible);
      textualBtn.setAttribute('aria-pressed', String(!isExact && compatible));

      const textualLabel = textualBtn.querySelector('.mode-selector-label');
      if (compatible) {
        textualBtn.disabled = false;
        textualBtn.removeAttribute('aria-disabled');
        if (textualLabel) textualLabel.textContent = t('generate.stage_file.textual_short', 'Contenido textual');
      } else {
        textualBtn.disabled = true;
        textualBtn.setAttribute('aria-disabled', 'true');
        if (textualLabel) textualLabel.textContent = t('generate.stage_file.textual_unavailable', 'No disponible para este formato');
        // Un archivo incompatible con modo textual nunca puede quedarse en
        // ese modo — si lo estuviera por cualquier motivo, se fuerza a
        // Archivo exacto, que siempre es válido para cualquier archivo.
        if (!isExact) { setActiveMode('exact-file'); return updateModeSelector(); }
      }

      if (indicatorTitle && indicatorText) {
        if (isExact) {
          indicatorTitle.textContent = t('generate.stage_file.exact_recommended', 'Archivo exacto — recomendado');
          indicatorText.textContent = t('generate.stage_file.exact_recommended_hint', 'Recomendado cuando quieres verificar el archivo completo tal como existe, incluidos formato y metadatos internos.');
        } else {
          indicatorTitle.textContent = t('generate.stage_file.textual_short', 'Contenido textual');
          indicatorText.textContent = t('generate.stage_file.textual_recommended_hint', 'Protege el texto normalizado; cambios de formato o maquetación pueden no alterar la identidad textual.');
        }
      }
    }

    function revealFileStageProgressively() {
      const wrapper = document.getElementById('mode-selector-wrapper');
      if (wrapper) wrapper.style.display = 'block';
      updateModeSelector();
      document.getElementById('questions-intro').style.display = 'block';
      document.getElementById('declaration-step').style.display = 'block';
      // La divulgación (DCL-03) solo tiene sentido para Archivo exacto —
      // Package Format 2.0 es su base; el contenido textual (familia
      // histórica v1.0) no la admite. Regla 9 del encargo: aparece al
      // final, después de las preguntas, nunca antes.
      const disclosureBlock = document.getElementById('disclosure-block');
      if (disclosureBlock) disclosureBlock.style.display = activeGenerationMode === 'exact-file' ? 'block' : 'none';
      updateSummaryAndGenerateVisibility();
    }

    const modeSelectExact = document.getElementById('mode-select-exact');
    const modeSelectTextual = document.getElementById('mode-select-textual');
    if (modeSelectExact) {
      modeSelectExact.addEventListener('click', () => {
        setActiveMode('exact-file');
        revealFileStageProgressively();
      });
    }
    if (modeSelectTextual) {
      modeSelectTextual.addEventListener('click', () => {
        if (modeSelectTextual.disabled) return;
        setActiveMode('document-content');
        revealFileStageProgressively();
      });
    }

    // Regla 8: el botón Generar (y el resumen que lo precede) solo aparecen
    // cuando la declaración está realmente lista — nunca antes, nunca
    // deshabilitado y visible de fondo como en versiones anteriores.
    function buildSummaryHTML() {
      const mode = activeGenerationMode;
      const modeLabel = mode === 'document-content'
        ? t('generate.step2.mode_file', 'Contenido de un documento')
        : t('generate.stage_file.exact_recommended', 'Archivo exacto');
      const aiSystem = (document.getElementById('ai-system') || {}).value || '';
      const humanReview = (document.getElementById('human-review') || {}).value || '';
      const humanReviewLabel = {
        full: t('generate.step1.q5.opt.full', 'Completa'),
        partial: t('generate.step1.q5.opt.partial', 'Parcial'),
        light: t('generate.step1.q5.opt.light', 'Ligera'),
      }[humanReview] || humanReview;
      const disclosureOn = document.getElementById('exact-disclosure-toggle').checked;
      const rows = [
        [t('generate.summary.file', 'Archivo'), selectedFile ? selectedFile.name : ''],
        [t('generate.summary.mode', 'Modalidad'), modeLabel],
        [t('generate.summary.ai_system', 'Sistema de IA'), aiSystem],
        [t('generate.summary.human_review', 'Revisión humana'), humanReviewLabel],
        [t('generate.summary.disclosure', 'Aviso público'),
          disclosureOn ? t('generate.summary.disclosure_yes', 'Sí') : t('generate.summary.disclosure_no', 'No')],
      ];
      return rows.map(([k, v]) => `<div class="summary-row"><span class="summary-key">${k}</span><span class="summary-val">${v ? escapeHtml(v) : '—'}</span></div>`).join('');
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function updateSummaryAndGenerateVisibility() {
      if (activeGenerationMode !== 'exact-file' && activeGenerationMode !== 'document-content') return;
      const ready = activeGenerationMode === 'exact-file' ? updateExactFileButton() : updateFileGenerateButton();
      const summarySection = document.getElementById('summary-section');
      const genAction = activeGenerationMode === 'exact-file'
        ? document.getElementById('exact-file-generation-action')
        : document.getElementById('generation-action');
      const otherGenAction = activeGenerationMode === 'exact-file'
        ? document.getElementById('generation-action')
        : document.getElementById('exact-file-generation-action');
      if (otherGenAction) otherGenAction.style.display = 'none';
      if (ready) {
        document.getElementById('summary-box').innerHTML = buildSummaryHTML();
        summarySection.style.display = 'block';
        if (genAction) genAction.style.display = 'block';
      } else {
        summarySection.style.display = 'none';
        if (genAction) genAction.style.display = 'none';
      }
    }
    // Cualquier cambio relevante recalcula si ya toca mostrar resumen+botón.
    if (form) {
      form.addEventListener('input', updateSummaryAndGenerateVisibility);
      form.addEventListener('change', updateSummaryAndGenerateVisibility);
    }
    const disclosureToggleForSummary = document.getElementById('exact-disclosure-toggle');
    if (disclosureToggleForSummary) disclosureToggleForSummary.addEventListener('change', updateSummaryAndGenerateVisibility);

    // ── Material europeo de publicación (BETA-02) — correspondencia automática ──
    const euKitToggle = document.getElementById('eu-kit-toggle');
    const euKitPreview = document.getElementById('eu-kit-preview');
    const euIconOverride = document.getElementById('eu-icon-override');
    function currentEuIconId() {
      const override = euIconOverride ? euIconOverride.value : '';
      if (override) return override;
      const type = document.getElementById('disclosure-type').value;
      return (typeof PTCEuIcons !== 'undefined') ? PTCEuIcons.iconIdForType(type) : null;
    }
    function renderEuKitPreview() {
      if (!euKitToggle || !euKitToggle.checked) { euKitPreview.hidden = true; return; }
      euKitPreview.hidden = false;
      const img = document.getElementById('eu-kit-preview-image');
      function showPreview() {
        const iconId = currentEuIconId();
        if (iconId && typeof PTCEuIcons !== 'undefined' && PTCEuIcons.getIconData) {
          const data = PTCEuIcons.getIconData(iconId);
          if (data) {
            // Usar los datos inline base64 para la preview — funciona en file://
            const b64 = btoa(String.fromCharCode(...new Uint8Array(data.black_svg)));
            img.innerHTML = `<img alt="" src="data:image/svg+xml;base64,${b64}" style="height:40px;"/>`;
          } else {
            img.innerHTML = '';
          }
        } else {
          img.innerHTML = '';
        }
      }
      if (typeof PTCEuIcons !== 'undefined') {
        showPreview();
      } else if (typeof window.loadEuIcons === 'function') {
        // Carga diferida con gestión de error explícita
        window.loadEuIcons(showPreview, function() {
          img.innerHTML = '<span style="font-size:.8rem;color:var(--ink-muted)">—</span>';
        });
      }
    }
    if (euKitToggle) euKitToggle.addEventListener('change', renderEuKitPreview);
    if (euIconOverride) euIconOverride.addEventListener('change', renderEuKitPreview);
    const disclosureTypeForEu = document.getElementById('disclosure-type');
    if (disclosureTypeForEu) disclosureTypeForEu.addEventListener('change', renderEuKitPreview);
  }

  return { init };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => GeneratorApp.init());
} else {
  GeneratorApp.init();
}

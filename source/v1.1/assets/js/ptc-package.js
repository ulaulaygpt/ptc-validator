/**
 * PTC-DISTRIBUTION-PACKAGE — contrato operativo del ZIP de entrega.
 *
 * El ZIP no es el objeto criptográfico normativo. Este módulo conserva y
 * relaciona la fuente, el objeto canónico, el artefacto PTC y las
 * representaciones derivadas sin introducir hashes adicionales.
 */
const PTCDistributionPackage = (() => {
  const CORPUS = Object.freeze({ r01: '1.1', ptc_f: '1.2', arch: '0.3' });
  const PACKAGE_TYPE = 'ptc-distribution';
  const PACKAGE_VERSION = '1.0';

  function dependencies() {
    if (typeof JSZip === 'undefined') throw new Error('JSZip library not loaded');
    if (typeof PTCCore === 'undefined') throw new Error('PTCCore not loaded');
    if (typeof PTCAdapters === 'undefined') throw new Error('PTCAdapters not loaded');
  }

  function baseNameFromSource(result) {
    if (!result || !result.source || !result.source.file) return 'reference';
    const safe = PTCAdapters.safeFileName(result.source.file.name, 'document.' + (result.source.ext || 'bin'));
    return safe.replace(/\.[^.]+$/, '') || 'document';
  }

  function readmeText(result, language = 'en') {
    const isReference = result.mode === 'reference';
    const separator = '─'.repeat(58);
    const content = {
      es: {
        title: 'PAQUETE DE DISTRIBUCIÓN PTC — validator.es',
        what: isReference
          ? 'Este paquete vincula criptográficamente una referencia documental (CSV + URL).'
          : 'Este paquete vincula criptográficamente el objeto textual canónico extraído del archivo fuente.',
        canonical: 'El artefacto normativo es canonical/document_with_ptc.txt. El ZIP es únicamente un contenedor de entrega.',
        source: isReference
          ? 'Este modo no contiene archivo fuente: vincula criptográficamente la referencia CSV + URL.'
          : 'La carpeta source/ conserva el archivo recibido sin modificar. El perfil actual protege el objeto textual canónico; no protege por separado los bytes de la fuente ni los del ZIP.',
        verify: 'Para verificarlo, sube este ZIP a validator.es.'
      },
      en: {
        title: 'PTC DISTRIBUTION PACKAGE — validator.es',
        what: isReference
          ? 'This package cryptographically binds a documentary reference (CSV + URL).'
          : 'This package cryptographically binds the canonical textual object extracted from the source file.',
        canonical: 'The normative artefact is canonical/document_with_ptc.txt. The ZIP is only a delivery container.',
        source: isReference
          ? 'This mode contains no source file: it cryptographically binds only the CSV + URL reference.'
          : 'The source/ folder preserves the received file unchanged. The current profile protects the canonical textual object; it does not separately protect the source bytes or the ZIP bytes.',
        verify: 'To verify it, upload this ZIP to validator.es.'
      },
      fr: {
        title: 'PAQUET DE DISTRIBUTION PTC — validator.es',
        what: isReference
          ? 'Ce paquet lie cryptographiquement une référence documentaire (CSV + URL).'
          : 'Ce paquet lie cryptographiquement l’objet textuel canonique extrait du fichier source.',
        canonical: 'L’artefact normatif est canonical/document_with_ptc.txt. Le ZIP est uniquement un conteneur de livraison.',
        source: isReference
          ? 'Ce mode ne contient aucun fichier source : il lie cryptographiquement la référence CSV + URL.'
          : 'Le dossier source/ conserve le fichier reçu sans modification. Le profil actuel protège l’objet textuel canonique ; il ne protège pas séparément les octets de la source ni ceux du ZIP.',
        verify: 'Pour le vérifier, téléversez ce ZIP sur validator.es.'
      }
    };
    const c = content[language] || content.en;
    return `${c.title}\n${separator}\n\n${c.what}\n\n${c.canonical}\n\n${c.source}\n\n${c.verify}\n\nR-01 v1.1: 10.5281/zenodo.21406620\nPTC-F v1.2: 10.5281/zenodo.21406680\nARCH v0.3: 10.5281/zenodo.21406665\nORCID: 0009-0000-8891-7021\n`;
  }

  function manifestFor(result, representations, files, sourceMeta) {
    return {
      package_type: PACKAGE_TYPE,
      package_version: PACKAGE_VERSION,
      protocol_profile: result.fields.version,
      corpus: { ...CORPUS },
      generated_utc: new Date().toISOString(),
      mode: result.mode,
      source: sourceMeta,
      processing: {
        input_adapter: result.source ? result.source.adapter : 'reference-csv-url',
        adapter_status: result.source && result.source.experimental ? 'experimental' : 'supported',
        normalization_profile: 'R-01 v1.1',
        generator: 'validator.es',
        generator_version: '1.0'
      },
      available_representations: representations,
      hash_scope: result.fields.hash_scope,
      hash_doc_sha256: result.fields.hash_doc_sha256,
      hash_ptc_sha256: result.fields.hash_ptc_sha256,
      hash_ethical_context_sha256: result.fields.hash_ethical_context_sha256,
      files
    };
  }

  async function build(result, options = {}) {
    dependencies();
    if (!result || !result.normalizedDoc || !result.ptc || !result.fields) {
      throw new Error('Incomplete generation result');
    }

    const canonicalArtifact = result.normalizedDoc + result.ptc;
    const canonicalCheck = await PTCCore.validate(canonicalArtifact);
    if (canonicalCheck.status !== 'valid') throw new Error('Canonical artefact failed self-validation');

    const zip = new JSZip();
    const files = [];
    const representations = [];
    let sourceMeta = null;
    let baseName = baseNameFromSource(result);

    if (result.source && result.source.file) {
      const sourceFile = result.source.file;
      const safeName = PTCAdapters.safeFileName(sourceFile.name, 'source.' + (result.source.ext || 'bin'));
      const sourcePath = 'source/' + safeName;
      const sourceBytes = await PTCAdapters.toArrayBuffer(sourceFile);
      zip.file(sourcePath, sourceBytes);
      files.push({ path: sourcePath, role: 'source_original' });
      baseName = safeName.replace(/\.[^.]+$/, '') || 'document';
      sourceMeta = {
        path: sourcePath,
        original_name: sourceFile.name,
        extension: result.source.ext || PTCAdapters.extensionOf(sourceFile.name),
        media_type: sourceFile.type || '',
        size_bytes: Number.isFinite(sourceFile.size) ? sourceFile.size : sourceBytes.byteLength,
        last_modified_utc: Number.isFinite(sourceFile.lastModified) && sourceFile.lastModified > 0
          ? new Date(sourceFile.lastModified).toISOString()
          : null
      };
    }

    zip.file('canonical/document.txt', result.normalizedDoc);
    zip.file('canonical/document_with_ptc.txt', canonicalArtifact);
    zip.file('ptc.txt', result.ptc);
    files.push(
      { path: 'canonical/document.txt', role: 'canonical_document' },
      { path: 'canonical/document_with_ptc.txt', role: 'canonical_artifact' },
      { path: 'ptc.txt', role: 'ptc_block' }
    );

    if (result.source && result.source.ext === 'md') {
      const path = `representations/${baseName}_with_ptc.md`;
      zip.file(path, canonicalArtifact);
      files.push({ path, role: 'representation_markdown' });
      representations.push('md');
    }

    if (result.source && result.source.ext === 'docx') {
      try {
        const docxBlob = await PTCAdapters.appendPTCtoDOCX(result.source.file, result.ptc);
        const docxBytes = await PTCAdapters.toArrayBuffer(docxBlob);
        const extracted = await PTCAdapters.extractArtifact({
          name: `${baseName}_with_ptc.docx`,
          async arrayBuffer() { return docxBytes; }
        });
        const check = await PTCCore.validate(extracted.text);
        if (check.status === 'valid' && check.fields.hash_doc_sha256 === result.fields.hash_doc_sha256) {
          const path = `representations/${baseName}_with_ptc.docx`;
          zip.file(path, docxBytes);
          files.push({ path, role: 'representation_docx' });
          representations.push('docx');
        }
      } catch (error) {
        if (options.onRepresentationError) options.onRepresentationError('docx', error);
      }
    }

    files.push(
      { path: 'manifest.json', role: 'manifest' },
      { path: 'README.txt', role: 'documentation' }
    );
    const manifest = manifestFor(result, representations, files, sourceMeta);
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('README.txt', readmeText(result, options.language || 'en'));

    const outputType = options.type || (typeof Blob !== 'undefined' ? 'blob' : 'nodebuffer');
    const data = await zip.generateAsync({ type: outputType });
    return {
      data,
      filename: `${baseName}_ptc.zip`,
      manifest,
      canonicalArtifact,
      representations: [...representations]
    };
  }

  return { CORPUS, PACKAGE_TYPE, PACKAGE_VERSION, readmeText, manifestFor, build };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PTCDistributionPackage;
if (typeof window !== 'undefined') window.PTCDistributionPackage = PTCDistributionPackage;

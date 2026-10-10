/**
 * PTC-ADAPTERS — Adaptadores compartidos de entrada y salida.
 *
 * El núcleo normativo permanece en ptc-core.js. Este módulo concentra las
 * transformaciones específicas de formato para que generación y validación
 * no mantengan extractores paralelos que puedan divergir.
 */
const PTCAdapters = (() => {
  const TEXT_EXTENSIONS = new Set(['txt', 'md']);

  function extensionOf(name) {
    const value = String(name || '');
    const idx = value.lastIndexOf('.');
    return idx >= 0 ? value.slice(idx + 1).toLowerCase() : '';
  }

  function safeFileName(name, fallback = 'source.bin') {
    const base = String(name || '').split(/[\\/]/).pop()
      .replace(/[\u0000-\u001f\u007f]/g, '_')
      .replace(/^\.+$/, '_');
    return base || fallback;
  }

  async function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) {
      return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    }
    if (input && typeof input.arrayBuffer === 'function') return await input.arrayBuffer();
    throw new Error('Input cannot be converted to ArrayBuffer');
  }

  async function decodeUtf8Strict(input) {
    const ab = await toArrayBuffer(input);
    return new TextDecoder('utf-8', { fatal: true }).decode(ab);
  }

  async function extractPDF(input) {
    if (!window.pdfjsLib) throw new Error('PDF.js library not loaded');
    const arrayBuffer = await toArrayBuffer(input);
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const LINE_GAP_THRESHOLD = 2;
    const PARA_GAP_MULTIPLIER = 1.8;
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const items = content.items.filter(item => item.str !== undefined && item.str !== '');

      items.sort((a, b) => {
        const yA = a.transform[5];
        const yB = b.transform[5];
        if (Math.abs(yA - yB) > LINE_GAP_THRESHOLD) return yB - yA;
        return a.transform[4] - b.transform[4];
      });

      let pageText = '';
      let prevY = null;
      let prevFontSize = null;
      for (const item of items) {
        const currentY = item.transform[5];
        const fontSize = Math.abs(item.transform[3]) || 12;
        if (prevY !== null) {
          const deltaY = prevY - currentY;
          if (deltaY > LINE_GAP_THRESHOLD) {
            pageText += deltaY > (prevFontSize || fontSize) * PARA_GAP_MULTIPLIER ? '\n\n' : '\n';
          } else if (deltaY < -LINE_GAP_THRESHOLD) {
            pageText += '\n';
          } else if (pageText.length > 0 && !pageText.endsWith(' ') && !item.str.startsWith(' ')) {
            pageText += ' ';
          }
        }
        pageText += item.str;
        prevY = currentY;
        prevFontSize = fontSize;
      }

      content.items.forEach(item => {
        if (item.hasEOL && pageText && !pageText.endsWith('\n')) pageText += '\n';
      });

      // PDF remains an experimental adapter. This transformation is shared
      // by generation and validation, making its behaviour deterministic
      // within this implementation even though cross-tool reproducibility is
      // not guaranteed by ARCH v0.3.
      fullText += pageText.trim() + '\n';
    }
    return fullText;
  }

  async function extractDOCXRaw(input) {
    if (!window.mammoth) throw new Error('Mammoth library not loaded');
    const arrayBuffer = await toArrayBuffer(input);
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value || '';
  }

  /**
   * Mammoth separates DOCX paragraphs with a blank LF line. The native DOCX
   * representation writes each physical PTC line as one paragraph. This
   * adapter rebuilds only the bottom-anchored PTC section into its normative
   * LF-only physical form; the document prefix is normalised by the common
   * core before hashing.
   */
  function reconstructDOCXArtifact(rawText) {
    const text = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n');

    let closeIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i] === '</PTC>') { closeIdx = i; break; }
      if (lines[i] !== '') return text;
    }
    if (closeIdx < 0) return text;

    let openIdx = -1;
    for (let i = closeIdx - 1; i >= 0; i--) {
      if (lines[i] === '<PTC>') { openIdx = i; break; }
    }
    if (openIdx < 0) return text;

    const physicalPTCLines = lines.slice(openIdx, closeIdx + 1).filter(line => line !== '');
    const documentPrefix = lines.slice(0, openIdx).join('\n');
    return PTCCore.normalizeText(documentPrefix) + physicalPTCLines.join('\n');
  }

  async function extractSource(file) {
    const ext = extensionOf(file && file.name);
    if (TEXT_EXTENSIONS.has(ext)) {
      return { ext, text: await decodeUtf8Strict(file), adapter: ext === 'md' ? 'text-markdown-utf8' : 'text-plain-utf8', experimental: false };
    }
    if (ext === 'pdf') {
      return { ext, text: await extractPDF(file), adapter: 'pdf-pdfjs', experimental: true };
    }
    if (ext === 'docx') {
      return { ext, text: await extractDOCXRaw(file), adapter: 'docx-mammoth', experimental: true };
    }
    throw new Error('Unsupported file format');
  }

  async function extractArtifact(file) {
    const ext = extensionOf(file && file.name);
    if (TEXT_EXTENSIONS.has(ext)) {
      return { ext, text: await decodeUtf8Strict(file), adapter: ext === 'md' ? 'text-markdown-utf8' : 'text-plain-utf8', experimental: false };
    }
    if (ext === 'pdf') {
      return { ext, text: await extractPDF(file), adapter: 'pdf-pdfjs', experimental: true };
    }
    if (ext === 'docx') {
      const raw = await extractDOCXRaw(file);
      return { ext, text: reconstructDOCXArtifact(raw), adapter: 'docx-mammoth-ptc', experimental: true };
    }
    throw new Error('Unsupported file format');
  }

  function xmlEscape(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function appendPTCtoDOCX(input, ptcBlock) {
    if (!window.JSZip) throw new Error('JSZip library not loaded');
    const docxZip = await JSZip.loadAsync(await toArrayBuffer(input));
    const docXml = docxZip.file('word/document.xml');
    if (!docXml) throw new Error('word/document.xml not found');

    let xml = await docXml.async('string');
    const lines = String(ptcBlock).split('\n');
    const paragraphs = lines.map((line, index) => {
      const pageBreak = index === 0 ? '<w:pPr><w:pageBreakBefore/></w:pPr>' : '';
      return `<w:p>${pageBreak}<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`;
    }).join('');

    // In WordprocessingML, sectPr must remain the final child of w:body.
    const sectPos = xml.lastIndexOf('<w:sectPr');
    if (sectPos >= 0) {
      xml = xml.slice(0, sectPos) + paragraphs + xml.slice(sectPos);
    } else {
      xml = xml.replace('</w:body>', paragraphs + '</w:body>');
    }
    docxZip.file('word/document.xml', xml);
    return await docxZip.generateAsync({ type: 'blob' });
  }

  return {
    TEXT_EXTENSIONS,
    extensionOf,
    safeFileName,
    toArrayBuffer,
    decodeUtf8Strict,
    extractPDF,
    extractDOCXRaw,
    reconstructDOCXArtifact,
    extractSource,
    extractArtifact,
    appendPTCtoDOCX
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PTCAdapters;
if (typeof window !== 'undefined') window.PTCAdapters = PTCAdapters;

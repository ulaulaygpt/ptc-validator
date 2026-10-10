/* ptc-package2.js — BETA-01
 * Construye un Validator Package Format 2.0 (PKG-02) a partir de un
 * objeto canónico FRS-01 [+ DCL-03] ya validado. Usa JSZip, ya cargado
 * por la página. No toca ptc-package.js (formato histórico v1.0).
 */
const PTCPackage2 = (() => {

  function safeName(name) {
    // Nombre original solo como metadato informativo (manifest.json);
    // nunca forma parte del objeto canónico ni de una ruta interior fija.
    return String(name || 'archivo').replace(/[\\/]/g, '_');
  }

  function guessExtension(name) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(name || '');
    return m ? m[1] : '';
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── Construcción completa del paquete ────────────────────────────────────
  // params:
  //   file: File — la fuente exacta, tratada como bytes opacos.
  //   ptcResult: { canonicalObject, ptcBlock, integratedRecord } — ya generados.
  //   disclosure: null | { type, language, verificationUrl }
  //   includeEuKit: boolean — si se incluye el material europeo de publicación
  //     (BETA-02). Solo tiene efecto si existe disclosure. La correspondencia
  //     type -> icono es automática (PTCEuIcons); Validator no la convierte
  //     en autoridad ni en un nuevo hash: son archivos declarados dentro de
  //     public_notice, exactamente como permite PKG-02 §9.
  async function buildPackage({ file, sizeBytes, sourceSha256, canonicalObject, ptcBlock, disclosure, includeEuKit = false, euIconIdOverride }) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip no está cargado.');

    const integratedRecord = canonicalObject + ptcBlock;
    const zip = new JSZip();
    let euIconIncluded = false;
    let euIconFailed = false;

    const originalName = safeName(file.name);
    const mediaType = file.type || 'application/octet-stream';

    zip.file(`source/${originalName}`, await file.arrayBuffer());
    zip.file('canonical/file_reference.txt', canonicalObject);
    zip.file('canonical/file_reference_with_ptc.txt', integratedRecord);
    zip.file('ptc.txt', ptcBlock);

    const manifest = {
      package_format_version: '2.0',
      input_adapter: 'file-reference-sha256-v1',
      source_path: `source/${originalName}`,
      canonical_path: 'canonical/file_reference.txt',
      canonical_with_ptc_path: 'canonical/file_reference_with_ptc.txt',
      ptc_path: 'ptc.txt',
      readme_path: 'README.txt',
      original_filename: file.name || originalName,
      media_type: mediaType,
    };

    let readme =
      'PTC Package Format 2.0 conformance package\n\n' +
      'Verify the integrated record first (canonical/file_reference_with_ptc.txt),\n' +
      'then compare the derived copies and source/. The outer ZIP hash is\n' +
      'informative and is not a normative root of trust.\n';

    if (disclosure) {
      const noticeTxt = PTCFileReference.buildNoticeText(disclosure.type, disclosure.language, disclosure.verificationUrl);
      const noticeHtml = PTCFileReference.buildNoticeHtml(disclosure.type, disclosure.language, disclosure.verificationUrl);
      const noticeSvg = PTCFileReference.buildNoticeSvg(disclosure.type, disclosure.language, disclosure.verificationUrl);

      zip.file('PUBLIC_NOTICE/notice.txt', noticeTxt);
      zip.file('PUBLIC_NOTICE/notice.html', noticeHtml);
      zip.file('PUBLIC_NOTICE/notice.svg', noticeSvg);
      zip.file('PUBLIC_NOTICE/README.txt',
        'Derived presentation artefacts for the protected disclosure declared in ptc.txt.\n' +
        'notice.txt is the normative minimal representation, verifiable byte for byte.\n' +
        'notice.html, notice.svg and qr.svg (when present) are presentation only.\n'
      );

      manifest.public_notice = {
        profile: 'disclosure-notice-v1',
        notice_path: 'PUBLIC_NOTICE/notice.txt',
        html_path: 'PUBLIC_NOTICE/notice.html',
        svg_path: 'PUBLIC_NOTICE/notice.svg',
        readme_path: 'PUBLIC_NOTICE/README.txt',
      };

      // notice.txt/manifest reflejan SIEMPRE la verification_url tal como
      // está en el bloque protegido (coherencia con hash_doc_sha256, ya
      // calculado antes de llegar aquí). Un fallo del generador de QR solo
      // omite qr.svg — nunca reescribe la declaración ya protegida.
      let qrOmittedByFailure = false;
      if (disclosure.verificationUrl) {
        manifest.public_notice.verification_url = disclosure.verificationUrl;
        try {
          const qrSvg = buildQrSvg(disclosure.verificationUrl);
          zip.file('PUBLIC_NOTICE/qr.svg', qrSvg);
          manifest.public_notice.qr_path = 'PUBLIC_NOTICE/qr.svg';
        } catch (err) {
          qrOmittedByFailure = true;
        }
      }

      readme += '\nThis package includes a public disclosure notice under PUBLIC_NOTICE/.\n' +
        'Validator checks the notice against the protected declaration; it does not\n' +
        'prove the notice was shown publicly.\n';
      if (qrOmittedByFailure) {
        readme += '\nNote: qr.svg could not be generated in this session and was omitted.\n' +
          'This does not affect the validity of the protected declaration or of notice.txt.\n';
      }

      // ── Kit europeo de publicación (BETA-02) — opcional, declarado ──────
      // Archivos oficiales de la Comisión Europea, sin modificar, incluidos
      // como entradas declaradas dentro de public_notice (PKG-02 §9). No
      // crean autoridad ni afectan a ningún hash normativo.
      if (includeEuKit && typeof PTCEuIcons !== 'undefined') {
        const iconId = euIconIdOverride || PTCEuIcons.iconIdForType(disclosure.type);
        if (iconId) {
          try {
            // Datos inline desde eu-icons.js — funciona en file:// y HTTP
            const iconData = PTCEuIcons.getIconData(iconId);
            if (!iconData) throw new Error('EU_ICON_NOT_FOUND');
            const euFiles = {
              black_svg: iconData.black_svg,
              black_png: iconData.black_png,
              white_svg: iconData.white_svg,
              white_png: iconData.white_png,
            };
            const kitDir = 'PUBLIC_NOTICE/eu-icon';
            zip.file(`${kitDir}/${iconId}_black.svg`, euFiles.black_svg);
            zip.file(`${kitDir}/${iconId}_black.png`, euFiles.black_png);
            zip.file(`${kitDir}/${iconId}_white.svg`, euFiles.white_svg);
            zip.file(`${kitDir}/${iconId}_white.png`, euFiles.white_png);
            zip.file(`${kitDir}/README.txt`,
              'Official European Commission icon, unmodified.\n' +
              'Source: https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content\n' +
              'Free to use, no attribution required. Its inclusion here does not determine\n' +
              'a legal obligation to use it, does not certify compliance with Article 50 of\n' +
              'Regulation (EU) 2024/1689, and does not imply Validator or its operator are\n' +
              'signatories of the Code of Practice on marking and labelling of AI-generated\n' +
              'content. See PROVENANCE.md in the Validator source for full details.\n'
            );

            // Cada activo distribuido queda declarado por ruta Y por SHA-256
            // (comprobación pedida antes de continuar). Una alteración de
            // cualquiera de estos cuatro archivos solo puede afectar al eje
            // Paquete — nunca son parte del objeto canónico protegido ni del
            // PTC, así que jamás pueden tocar los ejes PTC, fuente o
            // divulgación por sí solos.
            const [blackSvgSha, blackPngSha, whiteSvgSha, whitePngSha] = await Promise.all([
              sha256Hex(euFiles.black_svg), sha256Hex(euFiles.black_png),
              sha256Hex(euFiles.white_svg), sha256Hex(euFiles.white_png),
            ]);

            manifest.public_notice.eu_icon_kit = {
              icon_id: iconId,
              source: 'European Commission — Code of Practice on marking and labelling of AI-generated content',
              source_url: 'https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content',
              black_svg_path: `${kitDir}/${iconId}_black.svg`,
              black_svg_sha256: blackSvgSha,
              black_png_path: `${kitDir}/${iconId}_black.png`,
              black_png_sha256: blackPngSha,
              white_svg_path: `${kitDir}/${iconId}_white.svg`,
              white_svg_sha256: whiteSvgSha,
              white_png_path: `${kitDir}/${iconId}_white.png`,
              white_png_sha256: whitePngSha,
              readme_path: `${kitDir}/README.txt`,
            };
            euIconIncluded = true;
            readme += '\nThis package also includes the official EU icon corresponding to the\n' +
              'declared type, unmodified (see PUBLIC_NOTICE/eu-icon/README.txt). Its\n' +
              'presence does not determine legal obligation nor certify compliance.\n';
          } catch (err) {
            euIconFailed = true;
          }
        }
      }
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    zip.file('README.txt', readme);

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const base = originalName.replace(/\.[^.]+$/, '') || 'declaracion';
    return { blob, filename: `${base}_ptc_frs01.zip`, manifest, euIconIncluded, euIconFailed };
  }

  // ── QR alta definición con triángulo de marca centrado ─────────────────
  // ecl:'H' aumenta la tolerancia al daño del QR; no concede un porcentaje
  // libre para logos. La zona central oculta módulos deliberadamente: la
  // robustez depende de la redundancia del código, no de un margen garantizado.
  // Mantener el triángulo pequeño (≈ 1 % del área) para lectura real fiable.
  // El △ es identidad de la implementación Validator, no requisito de DCL-03.
  function buildQrSvg(url) {
    if (typeof QRCode === 'undefined') throw new Error('QR_GENERATOR_NOT_AVAILABLE');

    const SIZE = 512;
    const qr = new QRCode({
      content:    url,
      padding:    4,
      width:      SIZE,
      height:     SIZE,
      color:      '#000000',
      background: '#ffffff',
      ecl:        'H'
    });
    const baseSvg = qr.svg();

    // Triángulo equilátero, lado 72 px, centrado en (256, 256)
    // h = lado * √3/2 ≈ 62 px; baricentro a h/3 ≈ 21 px del lado base
    const cx = SIZE / 2, cy = SIZE / 2, lado = 72;
    const h  = Math.round(lado * Math.sqrt(3) / 2);
    const vT = { x: cx,              y: cy - Math.round(h * 2 / 3) };
    const vL = { x: cx - lado / 2,   y: cy + Math.round(h / 3)     };
    const vR = { x: cx + lado / 2,   y: cy + Math.round(h / 3)     };
    const pts = `${vT.x},${vT.y} ${vL.x},${vL.y} ${vR.x},${vR.y}`;

    // Zona de despeje blanca (cuadrado, margen 10 px a cada lado del triángulo)
    const cSz = lado + 20, cX = cx - cSz / 2, cY = cy - cSz / 2;

    const logo =
      `<rect x="${cX}" y="${cY}" width="${cSz}" height="${cSz}" fill="#ffffff"/>` +
      `<polygon points="${pts}" fill="#ffffff" stroke="#5B21B6" stroke-width="2.5" stroke-linejoin="round"/>`;

    return baseSvg.replace('</svg>', logo + '</svg>');
  }

  return { buildPackage, safeName, guessExtension };
})();

if (typeof window !== 'undefined') window.PTCPackage2 = PTCPackage2;

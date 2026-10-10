# validator.es — Changelog

## [v1.1] — 2026-08-07

Segunda iteración mayor. Incorpora Package Format 2.0, tres nuevas especificaciones normativas,
modo de archivo exacto, declaración pública DCL-03 y revisión completa de la interfaz web.

### Corpus normativo

- **FRS-01 v0.3** — Perfil de archivo exacto: vincula un PTC a los bytes de cualquier archivo
  sin interpretar su formato. DOI 10.5281/zenodo.21830122.
- **PKG-02 v0.4** — Validator Package Format 2.0: estructura del paquete, cuatro ejes de
  verificación y autoridad de cada pieza. DOI 10.5281/zenodo.21830169.
- **DCL-03 v0.3** — Perfil de aviso público: artefacto opcional de divulgación verificable
  para contenido generado o modificado con IA. DOI 10.5281/zenodo.21830264.
- R-01, PTC-F y ARCH sin cambios normativos respecto de v1.0.1.

### Motor y verificación

- Modo exacto (`ptc-frs.js`): protección byte a byte de cualquier archivo; compatible con
  PKG-02 y verificable por el mismo verificador.
- Package Format 2.0 (`ptc-package2.js`): cuatro ejes independientes (declaración PTC,
  archivo fuente, estructura del paquete, divulgación pública cuando existe).
- Verificador ampliado (`validate-pkg2.js`): distingue paquetes 2.0, paquetes históricos,
  artefactos textuales y ZIP ordinarios sin reducir todo a un semáforo único.
- Motor núcleo, adaptadores y contratos normativos sin cambios byte a byte respecto de v1.0.1.

### Interfaz web

- Pantalla inicial unificada: acepta cualquier archivo; modo exacto predeterminado.
- Selector de sistema de IA reabrible (CREATE-04) y campo "Otro — caso no cubierto" (CREATE-05).
- Aviso público DCL-03 como rama opcional al final del formulario.
- Material europeo condicionado (iconos AI Act) integrado en el paquete cuando se solicita.
- CSS: `body > header` limita el sticky al encabezado principal (LAYOUT-01).
- QR de divulgación: 512 px, corrección de error H, triángulo △ como identidad de Validator
  (no requisito normativo de DCL-03).

### Páginas y contenido

- `why.html`: eliminadas afirmaciones de garantía, inmutabilidad y prueba de verdad material.
- `regulation.html`: reconstruida con Art. 50 aplicable desde 2-ago-2026, separación
  proveedor/deployer, período transitorio hasta 2-dic-2026, DCL-03 sin sobreprometer.
- `faq.html` → `Ayuda`: reconstruida con tres modos, Package Format 2.0 y 16 preguntas.
- `specs.html`: seis especificaciones en dos capas (Núcleo / Perfiles y formatos), DOIs reales.
- Terminología: "vincula criptográficamente" sustituye a "certifica" en textos generados.
- Distribución local (antes "Portable"): mismo árbol que validator.es, sin edición separada.

### Distribución

- DOI de esta publicación: 10.5281/zenodo.21833853.
- El árbol web y el artefacto local son el mismo conjunto de archivos.

---

## [v1.0.1] — 2026-07-26

Versión correctiva. No modifica R-01, PTC-F ni ARCH.

- `ai_system` y `co_creation_mode` pasan de lista cerrada a texto libre.
- Ayudas de nivel alineadas con PTC-F sin convertir ejemplos en requisitos.
- `human_review` conserva los tres valores normativos con etiquetas más precisas.
- Validación inmediata del carácter prohibido `|` y espacios en bordes.
- Eliminada introducción duplicada en Crear PTC.
- Corregida localización dinámica de ayudas, errores y paquetes en ES/EN/FR.

---

## [v1.0] — 2026-07-21

Primera versión con corpus normativo publicado (R-01 v1.1, PTC-F v1.2, ARCH v0.3).

- Núcleo único `ptc-core.js`; ningún cálculo criptográfico fuera del núcleo.
- Verificación obligatoria de los tres hashes, incluido `hash_ethical_context_sha256`.
- Comparación de forma canónica: bloque con hashes autoconsistentes pero forma física
  distinta se rechaza (`E_NON_CANONICAL_FORM`).
- Vinculación `hash_scope` ↔ objeto protegido.
- Autovalidación obligatoria antes de ofrecer cualquier descarga.
- Soporte Markdown como texto UTF-8 estricto.
- Paquete de distribución PTC con estructura definida; empaquetado separado en `ptc-package.js`.
- Sitio trilingüe ES/EN/FR con hreflang, sitemap y datos estructurados.

# Procedencia de los iconos europeos de etiquetado de contenido con IA

**Fecha de descarga:** 4 de agosto de 2026
**Fuente oficial:** https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content
**Última actualización de la página fuente, según la propia Comisión:** 20 de julio de 2026
**Parte de:** Section 2 del Code of Practice on marking and labelling of AI-generated content

## Enlaces de descarga verificados

- SVG (ZIP oficial): `https://ec.europa.eu/newsroom/dae/redirection/document/129546` — 20.941 bytes, 12 archivos
- PNG (ZIP oficial): `https://ec.europa.eu/newsroom/dae/redirection/document/129547` — 663.761 bytes, 12 archivos

Ambos verificados como archivos ZIP válidos, descargados directamente de dominios oficiales de la Comisión Europea (`digital-strategy.ec.europa.eu`, `ec.europa.eu`), sin intermediarios.

## Licencia, citada literalmente de la página oficial

> "These icons are made publicly available for everyone to use freely, without the need for attribution to the Commission or the AI Office. However, signatories of the code of practice should use the icon in accordance with its placement specifications. Usage of these icons by non-signatories of the code should not be construed as signaling of their adherence to the code."

**El Canal / Validator no es firmante del Code of Practice.** El uso de estos iconos en Validator no debe interpretarse como adhesión a dicho Código.

## Los tres iconos oficiales y su uso previsto (tabla de la propia Comisión)

| Icono | Cuándo usarlo, según la Comisión |
|---|---|
| **Basic icon** | Cuando la IA intervino en contenido deepfake (imagen, audio, vídeo) o texto publicado, o cuando se implementa una etiqueta de texto personalizada o una segunda capa interactiva |
| **Fully AI-Generated** | Cuando todo el contenido deepfake o texto está generado íntegramente por IA, sin elementos creados por humanos ni control editorial humano (aparte de la instrucción). Ejemplos citados explícitamente por la Comisión: vídeos deepfake totalmente generados, **música o arte totalmente compuestos por IA**, resúmenes de noticias generados por IA |
| **Partially AI-Modified** | Cuando contenido preexistente, hecho por humanos, se modificó parcialmente con IA convirtiéndolo en un deepfake o en texto sobre asuntos de interés público |

## Errata detectada en el propio archivo oficial — conservada, no corregida

El ZIP oficial de SVG nombra el archivo del icono "Partially AI-Modified" en negro sólido como:

```
LABEL_AI MOFIFIED_black.svg
```

Falta una "D" ("MOFIFIED" en vez de "MODIFIED"). Es un error tipográfico de la propia Comisión Europea, presente únicamente en esa variante SVG concreta — el archivo PNG equivalente (`LABEL_AI MODIFIED_black.png`) está bien escrito, y las otras tres variantes SVG del mismo icono (blanco, negro 50%, blanco 50%) también están bien escritas. El archivo se conserva exactamente como se descargó, sin corregir el nombre ni el contenido, en `assets/eu-icons/official/svg/`.

## Estructura de archivos en este repositorio

- `assets/eu-icons/official/{svg,png}/` — copia exacta e intacta de los 24 archivos tal como se descargaron de la Comisión, con sus nombres originales (incluida la errata). Nunca se sirve directamente desde la web; existe solo para trazabilidad y auditoría.
- `assets/eu-icons/{svg,png}/` — copias con nombre seguro para URL (sin espacios), **verificadas byte a byte idénticas a los archivos oficiales** antes de renombrarse. Ningún píxel se ha redibujado ni modificado.
- `assets/eu-icons/provenance.json` — registro máquina-legible de la correspondencia entre cada nombre oficial y su copia con nombre seguro, con el SHA-256 de cada archivo.

## Correspondencia de nombres

| Icono | Variante | Nombre oficial (SVG) | Nombre usado en Validator |
|---|---|---|---|
| Básico | negro | `LABEL_AI_black.svg` | `basic_black.svg` |
| Básico | blanco | `LABEL_AI_white.svg` | `basic_white.svg` |
| Totalmente generado | negro | `LABEL_AI GENERATED_black.svg` | `fully-ai-generated_black.svg` |
| Totalmente generado | blanco | `LABEL_AI GENERATED_white.svg` | `fully-ai-generated_white.svg` |
| Parcialmente modificado | negro | `LABEL_AI MOFIFIED_black.svg` (errata oficial) | `partially-ai-modified_black.svg` |
| Parcialmente modificado | blanco | `LABEL_AI MODIFIED_white.svg` | `partially-ai-modified_white.svg` |

(Variantes al 50% de transparencia disponibles con el mismo patrón, sufijo `-50`.)

## Lo que Validator afirma y lo que no afirma sobre estos iconos

Validator puede afirmar:
- qué icono corresponde, según la regla mecánica aplicada al tipo de intervención declarado en el PTC DISCLOSURE;
- que el icono es el archivo oficial sin modificar, con su procedencia documentada.

Validator no afirma:
- que exista obligación legal de usar el icono para el contenido concreto del usuario;
- que el uso del icono acredite cumplimiento del Artículo 50 del Reglamento (UE) 2024/1689;
- que Validator o su operador sean firmantes del Code of Practice.

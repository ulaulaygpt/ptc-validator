# Validator v1.1 — Quick start

Validator is the reference implementation of the **PTC / CTP — Canal Transparency Protocol**.

It creates and verifies declarations about AI participation while processing the protected content locally in the browser.

## Create a declaration

1. Open [validator.es](https://validator.es) and choose **Crear PTC / Create PTC**.
2. Select the file you want to protect, or use an official-document reference when the source file is not available.
3. Choose what you want to protect:
   - **Exact file** — recommended when byte-level identity matters;
   - **Textual content** — when the canonical text matters more than physical formatting;
   - **Official reference** — when verification depends on an external official reference.
4. Declare who is making the statement, which AI system participated, the degree and mode of participation, the human review, purpose and date.
5. Generate and preserve the resulting package.

When possible, preserve and share the **complete generated ZIP package**.

## Verify a declaration

1. Open **Verificar / Verify**.
2. Select a PTC package or compatible file.
3. Validator checks the applicable technical axes locally:
   - PTC declaration;
   - protected/source object;
   - package structure;
   - public disclosure, when present.
4. Open the technical details when you need the hashes and field-level result.

## Privacy

The public web version processes the content locally in the browser. The source files are not uploaded to a Validator server.

## Limits

Validator verifies technical consistency and cryptographic correspondence. It does **not** prove that a declaration is truthful, establish legal authorship or replace legal/pericial assessment.

## Offline use

The canonical v1.1 package can be downloaded from Zenodo and opened locally. The included `index.html` does not require installation or a server.

- Canonical release: [DOI 10.5281/zenodo.21833853](https://doi.org/10.5281/zenodo.21833853)
- Normative stack: [ptc-ctp](https://github.com/ulaulaygpt/ptc-ctp)
- Wider ecosystem: [github.com/ulaulaygpt](https://github.com/ulaulaygpt)

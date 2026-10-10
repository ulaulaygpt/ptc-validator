/* Shared, dependency-free drag-and-drop enhancement for file inputs. */
(() => {
  function t(key, fallback) {
    return (window.I18n && I18n.t) ? I18n.t(key, fallback) : fallback;
  }

  function initZone(zone) {
    const inputId = zone.getAttribute('data-input-id');
    const input = inputId ? document.getElementById(inputId) : null;
    const fileEl = zone.querySelector('.drop-zone-file');
    if (!input) return;

    const syncDisabled = () => {
      const disabled = !!input.disabled;
      zone.classList.toggle('is-disabled', disabled);
      if (disabled) zone.setAttribute('aria-disabled', 'true');
      else zone.removeAttribute('aria-disabled');
    };

    const showFile = () => {
      const file = input.files && input.files[0];
      zone.classList.toggle('has-file', !!file);
      if (!fileEl) return;
      if (!file) { fileEl.textContent = ''; return; }
      const key = fileEl.getAttribute('data-ready-key');
      const fallback = fileEl.getAttribute('data-ready-fallback') || 'File ready';
      fileEl.textContent = `${t(key, fallback)}: ${file.name}`;
    };

    ['dragenter','dragover'].forEach(type => zone.addEventListener(type, e => {
      e.preventDefault(); e.stopPropagation();
      if (!input.disabled) zone.classList.add('is-dragover');
    }));
    ['dragleave','drop'].forEach(type => zone.addEventListener(type, e => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.remove('is-dragover');
    }));
    zone.addEventListener('drop', e => {
      if (input.disabled || !e.dataTransfer || !e.dataTransfer.files.length) return;
      const dt = new DataTransfer();
      dt.items.add(e.dataTransfer.files[0]);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      showFile();
    });
    if (zone.getAttribute('role') === 'button' || zone.hasAttribute('tabindex')) {
      zone.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && !input.disabled) {
          e.preventDefault(); input.click();
        }
      });
    }
    input.addEventListener('change', showFile);
    new MutationObserver(syncDisabled).observe(input, { attributes: true, attributeFilter: ['disabled'] });
    window.addEventListener('i18n:changed', showFile);
    syncDisabled(); showFile();
  }

  const init = () => document.querySelectorAll('.drop-zone').forEach(initZone);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

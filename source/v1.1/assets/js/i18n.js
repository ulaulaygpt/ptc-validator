/* i18n.js — offline-first
 * Priority: window.I18nData[lang] (injected by i18n/XX.js) → fetch(assets/i18n/XX.json)
 * Works from file://, intranet, USB, and standard HTTP server.
 */
const I18n = (() => {
  let currentLang = 'es';
  let translations = {};
  const STORAGE_KEY = 'acs6-lang';

  async function loadLanguage(lang) {
    const l = (lang || 'es').toLowerCase();

    // 1. Try inline data (loaded via <script src="assets/i18n/XX.js">)
    if (window.I18nData && window.I18nData[l]) {
      translations = window.I18nData[l];
      currentLang  = l;
      try { localStorage.setItem(STORAGE_KEY, l); } catch (_) {}
      applyTranslations();
      updateLangUI();
      try { document.documentElement.lang = l; } catch (_) {}
      window.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: l } }));
      return;
    }

    // 2. Fallback: fetch JSON (works on HTTP server, fails silently on file://)
    try {
      const url = `assets/i18n/${l}.json?v=${Date.now()}`;
      const res  = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      translations = await res.json();
      currentLang  = l;
      try { localStorage.setItem(STORAGE_KEY, l); } catch (_) {}
    } catch (_) {
      // Keep previous translations; don't break
    }

    applyTranslations();
    updateLangUI();
    try { document.documentElement.lang = currentLang; } catch (_) {}
    window.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: currentLang } }));
  }

  function updateLangUI() {
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-lang') === currentLang);
    });
  }

  function applyTranslations(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const v = getTranslation(el.getAttribute('data-i18n'));
      if (typeof v === 'string') el.textContent = v;
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const v = getTranslation(el.getAttribute('data-i18n-placeholder'));
      if (typeof v === 'string') el.placeholder = v;
    });
    root.querySelectorAll('option[data-i18n]').forEach(el => {
      const v = getTranslation(el.getAttribute('data-i18n'));
      if (typeof v === 'string') el.textContent = v;
    });
  }

  function getTranslation(key) {
    if (!key) return null;
    return key.split('.').reduce((o, k) =>
      (o && typeof o === 'object' && k in o) ? o[k] : null, translations);
  }

  function t(key, fallback = '') {
    const v = getTranslation(key);
    return typeof v === 'string' ? v : (fallback || key);
  }

  function getCurrentLang() { return currentLang; }

  function currentPageName() {
    const last = (window.location.pathname.split('/').filter(Boolean).pop() || 'index.html');
    return last.endsWith('.html') ? last : 'index.html';
  }

  function languageFromPath() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const last = (parts[parts.length - 1] || '').toLowerCase();
    if (['en','fr'].includes(last)) return last; // directory URL: /en or /en/
    const parent = parts.length >= 2 ? parts[parts.length - 2].toLowerCase() : '';
    return ['en','fr'].includes(parent) ? parent : 'es';
  }

  function languageTarget(lang) {
    const target = (lang || 'es').toLowerCase();
    const page = currentPageName();
    const current = languageFromPath();
    if (window.location.protocol === 'file:') {
      if (current === 'es') return target === 'es' ? page : `${target}/${page}`;
      return target === 'es' ? `../${page}` : `../${target}/${page}`;
    }
    const suffix = page === 'index.html' ? '' : page;
    return target === 'es' ? `/${suffix}` : `/${target}/${suffix}`;
  }

  function init() {
    let saved = languageFromPath();
    // Legacy ?lang= links remain supported but redirect to canonical language URLs.
    try {
      const urlLang = new URLSearchParams(window.location.search).get('lang');
      if (urlLang && ['es','en','fr'].includes(urlLang.toLowerCase())) {
        const target = languageTarget(urlLang.toLowerCase());
        if (window.location.search) { window.location.replace(target); return; }
        saved = urlLang.toLowerCase();
      }
    } catch (_) {}
    loadLanguage(saved);
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetLang = btn.getAttribute('data-lang');
        if (targetLang === languageFromPath()) { loadLanguage(targetLang); return; }
        const target = languageTarget(targetLang);
        const dynamicPages = new Set(['generate.html', 'validate.html']);
        if (dynamicPages.has(currentPageName())) {
          // Create/Verify keep transient form/file state while the UI language changes.
          try {
            window.history.replaceState(window.history.state, '', target);
          } catch (_) {
            window.location.href = target;
            return;
          }
          loadLanguage(targetLang);
          return;
        }
        // Static pages have authored ES/EN/FR HTML. Navigate to the localized file
        // instead of translating only fragments in place. This also works on file://.
        window.location.href = target;
      });
    });
  }

  return { init, loadLanguage, applyTranslations, getTranslation, t, getCurrentLang };
})();

window.I18n = I18n;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => I18n.init());
} else {
  I18n.init();
}

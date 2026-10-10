/* info-panel.js — WEB3-U2
 * Componente de información accesible y reutilizable: botón azul junto a
 * la etiqueta de un campo, que despliega una explicación solo al pulsarse
 * —nunca por hover—. No depende de anchuras fijas ni de posicionamiento
 * absoluto: es un bloque en línea que empuja el contenido siguiente, así
 * que nunca se desborda de la pantalla, en móvil o en escritorio.
 *
 * Patrón HTML esperado:
 *   <button class="info-btn" type="button" aria-expanded="false"
 *           aria-controls="info-X" aria-label="...">ⓘ</button>
 *   ...
 *   <div class="info-panel" id="info-X" hidden>
 *     <p>...</p>
 *     <button class="info-panel-close" type="button" aria-label="Cerrar">✕</button>
 *   </div>
 *
 * Comportamiento: un único panel abierto a la vez (abrir uno cierra los
 * demás); Escape cierra el que esté abierto; cerrar devuelve el foco al
 * botón que lo abrió, para no perder la posición de lectura o navegación.
 */
(() => {
  function closePanel(panel, { returnFocus = true } = {}) {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    const trigger = document.querySelector(`[aria-controls="${panel.id}"]`);
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (returnFocus) trigger.focus();
    }
  }

  function closeAllPanels(exceptId) {
    document.querySelectorAll('.info-panel').forEach(panel => {
      if (panel.id === exceptId) return;
      if (!panel.hidden) closePanel(panel, { returnFocus: false });
    });
  }

  function togglePanel(btn) {
    const targetId = btn.getAttribute('aria-controls');
    const panel = targetId ? document.getElementById(targetId) : null;
    if (!panel) return;
    const wasOpen = !panel.hidden;
    closeAllPanels(wasOpen ? null : targetId);
    if (wasOpen) {
      closePanel(panel);
    } else {
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const closeBtn = panel.querySelector('.info-panel-close');
      if (closeBtn) closeBtn.focus();
    }
  }

  document.addEventListener('click', e => {
    const infoBtn = e.target.closest('.info-btn');
    if (infoBtn) { togglePanel(infoBtn); return; }
    const closeBtn = e.target.closest('.info-panel-close');
    if (closeBtn) { closePanel(closeBtn.closest('.info-panel')); }
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const openPanel = document.querySelector('.info-panel:not([hidden])');
    if (openPanel) closePanel(openPanel);
  });
})();

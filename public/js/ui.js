window.UI = (function () {
  const ICONS = {
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V13M12 16.4v.1"/>',
  };

  function icon(name, size) {
    return `<svg width="${size || 16}" height="${size || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  }

  let region;
  function toast(message, { type = 'check', duration = 4500 } = {}) {
    if (!region) {
      region = document.createElement('div');
      region.className = 'toast-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = icon(type);
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    region.appendChild(el);

    let remaining = duration;
    let started = Date.now();
    let timer = setTimeout(dismiss, remaining);

    function dismiss() {
      el.setAttribute('data-leaving', '');
      setTimeout(() => el.remove(), 200);
    }

    el.addEventListener('mouseenter', () => {
      clearTimeout(timer);
      remaining -= Date.now() - started;
    });
    el.addEventListener('mouseleave', () => {
      started = Date.now();
      timer = setTimeout(dismiss, Math.max(remaining, 1200));
    });
  }

  // Første klikk "armerer" knappen (viser bekreftelsestekst), andre klikk innen 4 s utfører handlingen.
  function confirmButton(button, onConfirm) {
    const idleLabel = button.innerHTML;
    let timer;
    function reset() {
      clearTimeout(timer);
      button.removeAttribute('data-armed');
      button.innerHTML = idleLabel;
    }
    button.addEventListener('click', (e) => {
      if (!button.hasAttribute('data-armed')) {
        e.preventDefault();
        button.setAttribute('data-armed', '');
        button.textContent = button.dataset.confirmLabel || 'Bekreft';
        timer = setTimeout(reset, 4000);
        return;
      }
      clearTimeout(timer);
      onConfirm(e, reset);
    });
    button.addEventListener('blur', () => setTimeout(() => button.isConnected && !button.disabled && reset(), 150));
    return reset;
  }

  // Skjemaknapper med data-confirm sendes først inn ved andre klikk.
  document.querySelectorAll('[data-confirm]').forEach((btn) => confirmButton(btn, () => {}));

  return { icon, toast, confirmButton };
})();

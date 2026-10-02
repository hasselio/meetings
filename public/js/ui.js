window.UI = (function () {
  const ICONS = {
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V13M12 16.4v.1"/>',
    monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
    back: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
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

  // Nedtrekkslister med data-autosubmit sender skjemaet med en gang et valg er gjort (f.eks. bedriftsvelgeren).
  document.querySelectorAll('select[data-autosubmit]').forEach((select) => {
    select.addEventListener('change', () => select.form.requestSubmit());
  });

  // Knapper med data-copy kopierer teksten til utklippstavlen.
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast(btn.dataset.copyDone || 'Kopiert.');
      } catch (_) {
        window.prompt('Kopier lenken:', btn.dataset.copy);
      }
    });
  });

  // Skjemaknapper med data-confirm sendes først inn ved andre klikk.
  document.querySelectorAll('[data-confirm]').forEach((btn) => confirmButton(btn, () => {}));

  // Forhåndsvisning av den offentlige siden i en modal, så admin slipper å bytte fane.
  let preview;
  function buildPreview() {
    const dialog = document.createElement('dialog');
    dialog.className = 'preview-dialog';
    dialog.setAttribute('aria-labelledby', 'previewTitle');
    dialog.innerHTML = `
      <div class="preview-dialog-head">
        <div class="preview-dialog-heading">
          <span class="preview-dialog-eyebrow">${icon('monitor', 14)}Slik ser besøkende siden</span>
          <h2 class="preview-dialog-title" id="previewTitle"></h2>
        </div>
        <div class="preview-dialog-actions">
          <span class="preview-dialog-note">Bookinger du gjør her, er ekte.</span>
          <button type="button" class="btn btn-primary btn-sm" data-close>${icon('back', 14)}Tilbake til admin</button>
        </div>
      </div>
      <div class="preview-dialog-body">
        <iframe title="Forhåndsvisning av den offentlige siden"></iframe>
      </div>`;
    document.body.appendChild(dialog);

    const frame = dialog.querySelector('iframe');
    const title = dialog.querySelector('.preview-dialog-title');

    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    // Hode og innhold fyller hele dialogen, så et klikk som treffer selve dialog-elementet er på bakteppet.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    frame.addEventListener('load', () => {
      if (frame.getAttribute('src') === 'about:blank') return;
      dialog.removeAttribute('data-loading');
      try {
        const doc = frame.contentDocument;
        title.textContent = doc.title;
        // Esc skal lukke også når fokus står inne i forhåndsvisningen.
        doc.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') dialog.close();
        });
      } catch (_) {}
    });
    dialog.addEventListener('close', () => {
      frame.setAttribute('src', 'about:blank');
      document.dispatchEvent(new CustomEvent('preview:closed'));
    });
    return { dialog, frame, title };
  }

  function openPreview(url) {
    preview = preview || buildPreview();
    preview.title.textContent = 'Laster …';
    preview.dialog.setAttribute('data-loading', '');
    preview.frame.setAttribute('src', url);
    preview.dialog.showModal();
  }

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-preview]');
    // Ctrl/Cmd/Shift-klikk og midtklikk beholder vanlig oppførsel (ny fane/vindu).
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openPreview(link.href);
  });

  return { icon, toast, confirmButton, openPreview };
})();

(function () {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const effective = () => root.dataset.theme || (media.matches ? 'dark' : 'light');

  function updateLabels() {
    const next = effective() === 'dark' ? 'lys' : 'mørk';
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.setAttribute('aria-label', `Bytt til ${next} modus`);
      button.title = `Bytt til ${next} modus`;
    });
  }

  function apply(theme) {
    root.dataset.theme = theme;
    // Forhåndsvisningen i admin (iframe) skal følge med uten omlasting.
    document.querySelectorAll('iframe').forEach((frame) => {
      try {
        frame.contentDocument.documentElement.dataset.theme = theme;
      } catch (_) {}
    });
    updateLabels();
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const next = effective() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('theme', next);
    } catch (_) {}
    apply(next);
  });

  // Valg gjort i en annen fane følger med.
  window.addEventListener('storage', (e) => {
    if (e.key === 'theme' && (e.newValue === 'light' || e.newValue === 'dark')) apply(e.newValue);
  });
  media.addEventListener('change', updateLabels);
  updateLabels();
})();

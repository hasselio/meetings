// Viser og skjuler endringsskjemaet for hver booking på siden bak lenken i e-posten.
document.querySelectorAll('[data-toggle-edit]').forEach((button) => {
  button.addEventListener('click', () => {
    const form = document.getElementById(button.dataset.toggleEdit);
    form.hidden = !form.hidden;
    document
      .querySelectorAll(`[aria-controls="${form.id}"]`)
      .forEach((b) => b.setAttribute('aria-expanded', String(!form.hidden)));
    if (!form.hidden) form.querySelector('input:not([type=hidden])').focus();
  });
});

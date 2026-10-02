// Søk og filter på forsiden. Uten JavaScript vises alle rom som før.
(function () {
  const form = document.getElementById('roomFilters');
  if (!form) return;
  form.hidden = false;

  const rows = Array.from(document.querySelectorAll('.room-row'));
  const text = document.getElementById('filterText');
  const capacity = document.getElementById('filterCapacity');
  // Finnes bare når flere bedrifter har rom.
  const orgSelect = document.getElementById('filterOrg');
  const date = document.getElementById('filterDate');
  const from = document.getElementById('filterFrom');
  const to = document.getElementById('filterTo');
  const chips = Array.from(form.querySelectorAll('[data-facility]'));
  const status = document.getElementById('filterStatus');
  const reset = document.getElementById('filterReset');
  const empty = document.getElementById('filterEmpty');

  // null = ikke filtrert på tid; ellers Map(romId → { free, reason }).
  let availability = null;
  let requestId = 0;

  const selectedFacilities = () => chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.facility);

  function timeRange() {
    if (!date.value || !from.value || !to.value) return null;
    const start = new Date(`${date.value}T${from.value}`);
    const end = new Date(`${date.value}T${to.value}`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
    return { start, end };
  }

  function apply() {
    const q = text.value.trim().toLowerCase();
    const minCapacity = Number(capacity.value) || 0;
    const orgId = orgSelect ? orgSelect.value : '';
    const facilities = selectedFacilities();
    const range = timeRange();
    let shown = 0;

    rows.forEach((row) => {
      const roomFacilities = row.dataset.facilities ? row.dataset.facilities.split(',') : [];
      const cap = Number(row.dataset.capacity) || 0;
      const slot = availability && availability.get(row.dataset.roomId);
      const visible =
        (!q || row.dataset.search.includes(q)) &&
        (!orgId || row.dataset.org === orgId) &&
        (!minCapacity || cap >= minCapacity) &&
        facilities.every((f) => roomFacilities.includes(f)) &&
        (!availability || (slot && slot.free));
      row.hidden = !visible;
      if (visible) shown++;
      // Romsiden fyller inn tiden man søkte på.
      const base = row.getAttribute('href').split('?')[0];
      row.setAttribute(
        'href',
        range && availability ? `${base}?dato=${date.value}&fra=${from.value}&til=${to.value}` : base
      );
    });

    const filtered = Boolean(q || orgId || minCapacity || facilities.length || date.value || from.value || to.value);
    reset.hidden = !filtered;
    empty.hidden = shown > 0;
    if (!filtered) status.textContent = '';
    else if (range && availability) status.textContent = `${shown} av ${rows.length} rom passer og er ledige i tidsrommet.`;
    else if (range) status.textContent = 'Sjekker ledige rom …';
    else if (date.value || from.value || to.value) status.textContent = 'Velg dato, fra og til for å se hvilke rom som er ledige.';
    else status.textContent = `Viser ${shown} av ${rows.length} rom.`;
  }

  async function refreshAvailability() {
    const range = timeRange();
    const id = ++requestId;
    if (!range) {
      availability = null;
      apply();
      return;
    }
    apply();
    try {
      const res = await fetch(
        `/api/availability?start=${encodeURIComponent(range.start.toISOString())}&end=${encodeURIComponent(range.end.toISOString())}`
      );
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (id !== requestId) return; // et nyere søk er på vei
      availability = new Map(data.rooms.map((r) => [String(r.id), r]));
    } catch (_) {
      availability = null;
      UI.toast('Kunne ikke sjekke ledige rom. Prøv igjen.', { type: 'alert' });
    }
    apply();
  }

  text.addEventListener('input', apply);
  capacity.addEventListener('change', apply);
  if (orgSelect) orgSelect.addEventListener('change', apply);
  chips.forEach((chip) =>
    chip.addEventListener('click', () => {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
      apply();
    })
  );
  [date, from, to].forEach((input) => input.addEventListener('change', refreshAvailability));
  // Velger man fra-tid uten til-tid, foreslås én time.
  from.addEventListener('change', () => {
    if (from.value && !to.value) {
      const [h, m] = from.value.split(':').map(Number);
      to.value = `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      refreshAvailability();
    }
  });
  reset.addEventListener('click', () => {
    form.reset();
    chips.forEach((c) => c.setAttribute('aria-pressed', 'false'));
    availability = null;
    apply();
    text.focus();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
})();

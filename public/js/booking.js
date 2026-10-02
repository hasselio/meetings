(function () {
  const calendarEl = document.getElementById('calendar');
  const roomId = calendarEl.dataset.roomId;
  const form = document.getElementById('bookingForm');
  const formAlert = document.getElementById('formAlert');
  const submitBtn = document.getElementById('submitBtn');
  const formView = document.getElementById('bookingFormView');
  const successView = document.getElementById('bookingSuccessView');
  const panel = document.getElementById('booking');
  const chips = Array.from(document.querySelectorAll('.chip'));

  const pad = (n) => String(n).padStart(2, '0');
  const toDateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toTimeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtDay = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtTime = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  const STORAGE_KEY = 'booking-contact';
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) {
      form.organizerName.value = saved.name || '';
      form.organizerEmail.value = saved.email || '';
    }
  } catch (_) {}

  function readRange() {
    const { date, startTime, endTime } = form;
    if (!date.value || !startTime.value || !endTime.value) return null;
    const start = new Date(`${date.value}T${startTime.value}`);
    const end = new Date(`${date.value}T${endTime.value}`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return { start, end };
  }

  function writeRange(start, end) {
    form.date.value = toDateValue(start);
    form.startTime.value = toTimeValue(start);
    form.endTime.value = toTimeValue(end);
    syncChips();
    clearError('time');
  }

  function syncChips() {
    const range = readRange();
    const minutes = range ? Math.round((range.end - range.start) / 60000) : null;
    chips.forEach((chip) => chip.setAttribute('aria-pressed', String(Number(chip.dataset.minutes) === minutes)));
  }

  const DAY_START = 7 * 60;
  const DAY_END = 19 * 60;
  const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
  const withinDay = (start, end) =>
    start.toDateString() === end.toDateString() && minutesOf(start) >= DAY_START && minutesOf(end) <= DAY_END;

  // Neste hele eller halve time fra nå; utenfor 07–19 blir det neste dag kl. 08.
  function defaultRange() {
    const start = new Date();
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() < 30 ? 30 : 60);
    if (!withinDay(start, new Date(start.getTime() + 60 * 60000))) {
      if (minutesOf(start) >= DAY_START) start.setDate(start.getDate() + 1);
      start.setHours(8, 0, 0, 0);
    }
    return { start, end: new Date(start.getTime() + 60 * 60000) };
  }

  let autoPicked = false;
  let userTouched = false;

  // Første ledige time fra nå, innenfor 07–19 og perioden kalenderen allerede har lastet.
  function nextFreeRange(events, limit) {
    const step = 30 * 60000;
    let start = defaultRange().start;
    while (start < limit) {
      const end = new Date(start.getTime() + 60 * 60000);
      const outside = !withinDay(start, end);
      const busy = events.some((e) => e.start < end && e.end > start);
      if (!outside && !busy) return { start, end };
      start = new Date(start.getTime() + step);
    }
    return null;
  }

  const errorFields = {
    time: ['endTime', 'timeError'],
    title: ['title', 'titleError'],
    organizerName: ['organizerName', 'organizerNameError'],
    organizerEmail: ['organizerEmail', 'organizerEmailError'],
  };

  function setError(key, message) {
    const [inputId, errorId] = errorFields[key];
    document.getElementById(inputId).setAttribute('aria-invalid', 'true');
    document.getElementById(errorId).textContent = message;
  }

  function clearError(key) {
    const [inputId, errorId] = errorFields[key];
    document.getElementById(inputId).removeAttribute('aria-invalid');
    document.getElementById(errorId).textContent = '';
  }

  function showAlert(message) {
    formAlert.innerHTML = `<div class="alert alert-error">${UI.icon('alert')}<span></span></div>`;
    formAlert.querySelector('span').textContent = message;
  }

  function validate() {
    Object.keys(errorFields).forEach(clearError);
    formAlert.innerHTML = '';
    let firstInvalid = null;
    const fail = (key, message) => {
      setError(key, message);
      firstInvalid = firstInvalid || document.getElementById(errorFields[key][0]);
    };

    const range = readRange();
    if (!range) fail('time', 'Velg dato og tidspunkt.');
    else if (range.end <= range.start) fail('time', 'Sluttid må være etter starttid.');
    else if (range.start < new Date()) fail('time', 'Tidspunktet har allerede passert.');

    if (!form.title.value.trim()) fail('title', 'Skriv kort hva møtet gjelder.');
    if (!form.organizerName.value.trim()) fail('organizerName', 'Skriv inn navnet ditt.');
    const email = form.organizerEmail.value.trim();
    if (!email) fail('organizerEmail', 'Vi trenger e-posten din for å sende invitasjonen.');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('organizerEmail', 'Sjekk at e-postadressen er riktig.');

    if (firstInvalid) firstInvalid.focus();
    return firstInvalid ? null : range;
  }

  const calendar = new FullCalendar.Calendar(calendarEl, {
    locale: 'nb',
    initialView: window.matchMedia('(max-width: 700px)').matches ? 'timeGridDay' : 'timeGridWeek',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,timeGridDay' },
    height: 'auto',
    allDaySlot: false,
    nowIndicator: true,
    slotMinTime: '07:00:00',
    slotMaxTime: '20:00:00',
    snapDuration: '00:15:00',
    businessHours: { daysOfWeek: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '17:00' },
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    dayHeaderFormat: { weekday: 'short', day: 'numeric' },
    selectable: true,
    selectMirror: true,
    unselectAuto: false,
    selectOverlap: false,
    selectAllow: (info) => info.start >= new Date(Date.now() - 15 * 60000),
    events(info, success, failure) {
      fetch(`/api/rooms/${roomId}/events?start=${encodeURIComponent(info.startStr)}&end=${encodeURIComponent(info.endStr)}`)
        .then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then((events) => {
          success(events);
          if (autoPicked) return;
          autoPicked = true;
          if (userTouched) return;
          const busy = events.map((e) => ({ start: new Date(e.start), end: new Date(e.end) }));
          const free = nextFreeRange(busy, info.end);
          if (free) setTimeout(() => {
            writeRange(free.start, free.end);
            selectFromForm();
          });
        })
        .catch(() => {
          failure();
          UI.toast('Kunne ikke hente kalenderen. Prøv å laste siden på nytt.', { type: 'alert' });
        });
    },
    select(info) {
      if (syncingFromForm) return;
      userTouched = true;
      showForm();
      writeRange(info.start, info.end);
      const rect = panel.getBoundingClientRect();
      if (rect.top > window.innerHeight || rect.bottom < 0) {
        panel.scrollIntoView({ block: 'start' });
      }
      if (!form.title.value) form.title.focus({ preventScroll: true });
    },
  });
  calendar.render();

  let syncingFromForm = false;
  function selectFromForm() {
    const range = readRange();
    syncChips();
    if (!range || range.end <= range.start) {
      calendar.unselect();
      return;
    }
    syncingFromForm = true;
    calendar.gotoDate(range.start);
    calendar.select(range.start, range.end);
    syncingFromForm = false;
  }

  ['date', 'startTime', 'endTime'].forEach((name) => {
    form[name].addEventListener('change', () => {
      userTouched = true;
      clearError('time');
      selectFromForm();
    });
  });

  ['title', 'organizerName', 'organizerEmail'].forEach((name) => {
    form[name].addEventListener('input', () => clearError(name));
  });

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      userTouched = true;
      const range = readRange() || defaultRange();
      const end = new Date(range.start.getTime() + Number(chip.dataset.minutes) * 60000);
      writeRange(range.start, end);
      selectFromForm();
    });
  });

  function showForm() {
    successView.hidden = true;
    formView.hidden = false;
  }

  document.getElementById('newBookingBtn').addEventListener('click', () => {
    form.title.value = '';
    form.notes.value = '';
    showForm();
    const { start, end } = defaultRange();
    writeRange(start, end);
    selectFromForm();
    form.title.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const range = validate();
    if (!range) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Booker …';

    const payload = {
      title: form.title.value.trim(),
      organizerName: form.organizerName.value.trim(),
      organizerEmail: form.organizerEmail.value.trim(),
      notes: form.notes.value.trim(),
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    };

    try {
      const res = await fetch(`/api/rooms/${roomId}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409) {
        showAlert('Noen andre har nettopp booket deler av denne tiden. Velg en annen tid.');
        calendar.refetchEvents();
        return;
      }
      if (!res.ok) {
        showAlert(data.error || 'Vi fikk ikke lagret bookingen. Prøv igjen om litt.');
        return;
      }

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: payload.organizerName, email: payload.organizerEmail }));
      } catch (_) {}

      document.getElementById('successWhen').textContent =
        `${fmtDay.format(range.start)}, ${fmtTime.format(range.start)}–${fmtTime.format(range.end)}`;
      document.getElementById('successTitleText').textContent = payload.title;
      document.getElementById('successMail').textContent = data.mailSent
        ? `Kalenderinvitasjonen er sendt til ${payload.organizerEmail}.`
        : 'Bookingen er lagret, men vi fikk ikke sendt e-post akkurat nå. Ta gjerne et skjermbilde.';

      formView.hidden = true;
      successView.hidden = false;
      document.getElementById('successTitle').focus();
      calendar.unselect();
      calendar.refetchEvents();
    } catch (_) {
      showAlert('Fikk ikke kontakt med serveren. Sjekk nettet og prøv igjen.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Book møte';
    }
  });

  const initial = defaultRange();
  writeRange(initial.start, initial.end);
  selectFromForm();
})();

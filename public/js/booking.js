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
  const widget = form.querySelector('altcha-widget');
  const pad = (n) => String(n).padStart(2, '0');

  // Romregler fra serveren: åpningstid, ukedager, maks varighet og hvor langt frem man kan booke.
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const toHHMM = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
  const rules = {
    from: toMinutes(calendarEl.dataset.openFrom || '07:00'),
    to: toMinutes(calendarEl.dataset.openTo || '20:00'),
    days: (calendarEl.dataset.openDays || '0,1,2,3,4,5,6').split(',').filter(Boolean).map(Number),
    maxMinutes: Number(calendarEl.dataset.maxMinutes) || null,
    maxDays: Number(calendarEl.dataset.maxDays) || null,
  };

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

  const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
  const DEFAULT_MINUTES = Math.min(60, rules.maxMinutes || 60);
  const withinDay = (start, end) =>
    start.toDateString() === end.toDateString() &&
    rules.days.includes(start.getDay()) &&
    minutesOf(start) >= rules.from &&
    minutesOf(end) <= rules.to;

  // Neste hele eller halve time fra nå; utenfor åpningstiden blir det første åpne dag.
  function defaultRange() {
    const start = new Date();
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() < 30 ? 30 : 60);
    for (let i = 0; i < 14 && !withinDay(start, new Date(start.getTime() + DEFAULT_MINUTES * 60000)); i++) {
      if (minutesOf(start) >= rules.from) start.setDate(start.getDate() + 1);
      start.setHours(Math.floor(Math.max(rules.from, 8 * 60) / 60), rules.from % 60, 0, 0);
    }
    return { start, end: new Date(start.getTime() + DEFAULT_MINUTES * 60000) };
  }

  let autoPicked = false;
  let userTouched = false;

  // Første ledige time fra nå, innenfor 07–19 og perioden kalenderen allerede har lastet.
  function nextFreeRange(events, limit) {
    const step = 30 * 60000;
    let start = defaultRange().start;
    while (start < limit) {
      const end = new Date(start.getTime() + DEFAULT_MINUTES * 60000);
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
    else if (!withinDay(range.start, range.end)) fail('time', 'Tiden er utenfor når rommet kan bookes.');
    else if (rules.maxMinutes && (range.end - range.start) / 60000 > rules.maxMinutes) {
      fail('time', `Rommet kan bookes i maks ${rules.maxMinutes} minutter om gangen.`);
    }

    if (range && repeatSelect.value !== 'none' && countOccurrences() > MAX_OCCURRENCES) {
      fail('time', `En serie kan ha maks ${MAX_OCCURRENCES} møter. Velg en tidligere sluttdato.`);
    }

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
    slotMinTime: toHHMM(Math.floor(Math.min(rules.from, 7 * 60) / 60) * 60),
    slotMaxTime: toHHMM(Math.ceil(Math.max(rules.to, 19 * 60) / 60) * 60),
    snapDuration: '00:15:00',
    businessHours: { daysOfWeek: rules.days, startTime: toHHMM(rules.from), endTime: toHHMM(rules.to) },
    selectConstraint: 'businessHours',
    validRange: rules.maxDays
      ? () => ({ end: new Date(Date.now() + (rules.maxDays + 1) * 24 * 3600 * 1000) })
      : undefined,
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
    repeatSelect.value = 'none';
    updateRepeat();
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

    let altcha = captchaPayload || new FormData(form).get('altcha');
    if (!altcha && widget && widget.verify) {
      submitBtn.textContent = 'Sjekker at du ikke er en robot …';
      try {
        await widget.verify();
      } catch (_) {}
      altcha = captchaPayload || new FormData(form).get('altcha');
    }

    const payload = {
      altcha,
      website: form.website.value,
      title: form.title.value.trim(),
      organizerName: form.organizerName.value.trim(),
      organizerEmail: form.organizerEmail.value.trim(),
      notes: form.notes.value.trim(),
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      repeat: repeatSelect.value,
      repeatUntil: form.repeatUntil.value,
      skipConflicts: form.skipConflicts.checked,
    };

    try {
      const res = await fetch(`/api/rooms/${roomId}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && data.code === 'taken') {
        showAlert('Noen andre har nettopp booket deler av denne tiden. Velg en annen tid.');
        calendar.refetchEvents();
        resetCaptcha();
        return;
      }
      if (!res.ok) {
        showAlert(data.error || 'Vi fikk ikke lagret bookingen. Prøv igjen om litt.');
        resetCaptcha();
        return;
      }
      resetCaptcha();

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: payload.organizerName, email: payload.organizerEmail }));
      } catch (_) {}

      const when = `${fmtDay.format(range.start)}, ${fmtTime.format(range.start)}–${fmtTime.format(range.end)}`;
      document.getElementById('successWhen').textContent =
        data.count > 1 ? `${data.count} møter, første ${when}` : when;
      const skippedList = document.getElementById('successSkipped');
      skippedList.replaceChildren();
      (data.skipped || []).forEach((s) => {
        const li = document.createElement('li');
        li.textContent = `Hoppet over ${s.when}: ${s.reason}`;
        skippedList.append(li);
      });
      skippedList.hidden = !(data.skipped && data.skipped.length);
      document.getElementById('successTitleText').textContent = payload.title;
      const pending = data.status === 'pending';
      document.getElementById('successTitle').textContent = pending
        ? 'Sjekk e-posten din'
        : data.count > 1
          ? 'Møtene er booket'
          : 'Møtet er booket';
      document.getElementById('successMail').textContent = pending
        ? `Vi har sendt en lenke til ${payload.organizerEmail}. Åpne den innen ${data.holdMinutes} minutter for å bekrefte; tiden holdes av til da.`
        : data.mailSent
          ? `Kalenderinvitasjonen er sendt til ${payload.organizerEmail}.`
          : 'Bookingen er lagret, men vi fikk ikke sendt e-post.';
      const manage = document.getElementById('successManage');
      manage.hidden = !data.manageUrl;
      if (data.manageUrl) {
        const link = document.getElementById('successManageLink');
        link.href = data.manageUrl;
        link.textContent = data.manageUrl;
      }

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

  // --- Gjentakelse ---
  const repeatSelect = form.repeat;
  const untilField = document.getElementById('repeatUntilField');
  const repeatExtra = document.getElementById('repeatExtra');
  const repeatSummary = document.getElementById('repeatSummary');
  const MAX_OCCURRENCES = Number(calendarEl.dataset.maxOccurrences) || 26;
  const DEFAULT_WEEKS = { weekdays: 1, weekly: 4, biweekly: 8 };

  function countOccurrences() {
    const range = readRange();
    if (!range || !form.repeatUntil.value) return 0;
    const until = new Date(`${form.repeatUntil.value}T23:59`);
    const step = repeatSelect.value === 'biweekly' ? 14 : repeatSelect.value === 'weekly' ? 7 : 1;
    let n = 0;
    for (const d = new Date(range.start); d <= until && n <= MAX_OCCURRENCES; d.setDate(d.getDate() + step)) {
      if (repeatSelect.value === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) continue;
      n++;
    }
    return n;
  }

  function updateRepeat({ resetUntil = false } = {}) {
    const repeating = repeatSelect.value !== 'none';
    untilField.hidden = !repeating;
    repeatExtra.hidden = !repeating;
    if (!repeating) return;
    const range = readRange();
    if ((resetUntil || !form.repeatUntil.value) && range) {
      const until = new Date(range.start);
      until.setDate(until.getDate() + DEFAULT_WEEKS[repeatSelect.value] * 7 - (repeatSelect.value === 'weekdays' ? 3 : 0));
      form.repeatUntil.value = toDateValue(until);
    }
    if (range) form.repeatUntil.min = toDateValue(range.start);
    const n = countOccurrences();
    if (n > MAX_OCCURRENCES) {
      repeatSummary.textContent = `For mange møter: maks ${MAX_OCCURRENCES} i en serie. Velg en tidligere dato.`;
      repeatSummary.setAttribute('data-warn', '');
    } else {
      repeatSummary.textContent = n ? `${n} møter i serien.` : '';
      repeatSummary.removeAttribute('data-warn');
    }
  }

  repeatSelect.addEventListener('change', () => updateRepeat({ resetUntil: true }));
  form.repeatUntil.addEventListener('change', () => updateRepeat());
  ['date', 'startTime', 'endTime'].forEach((name) => form[name].addEventListener('change', () => updateRepeat()));

  let captchaPayload = null;
  if (widget) {
    widget.addEventListener('statechange', (e) => {
      captchaPayload = e.detail && e.detail.state === 'verified' ? e.detail.payload : null;
    });
  }
  // En løst oppgave kan bare brukes én gang.
  function resetCaptcha() {
    captchaPayload = null;
    if (widget && widget.reset) widget.reset();
  }

  const initial = defaultRange();
  writeRange(initial.start, initial.end);
  selectFromForm();
})();

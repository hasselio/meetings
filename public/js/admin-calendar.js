(function () {
  const calendarEl = document.getElementById('calendar');
  const roomId = calendarEl.dataset.roomId;
  const canManage = Boolean(calendarEl.dataset.canManage);
  const overlay = document.getElementById('overlay');
  const drawer = document.getElementById('drawer');
  const closeBtn = document.getElementById('drawerClose');
  const view = document.getElementById('drawerView');
  const form = document.getElementById('adminBookingForm');
  const cancelBtn = document.getElementById('cancelBookingBtn');
  const cancelSeriesBtn = document.getElementById('cancelSeriesBtn');
  const editBtn = document.getElementById('editBookingBtn');

  const pad = (n) => String(n).padStart(2, '0');
  const toDateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toTimeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const toHHMM = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
  const fmtDay = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtTime = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fmtRange = (s, e) => `${fmtDay.format(s)}, ${fmtTime.format(s)}–${fmtTime.format(e)}`;
  const params = new URLSearchParams(location.search);

  const rules = {
    from: toMinutes(calendarEl.dataset.openFrom || '07:00'),
    to: toMinutes(calendarEl.dataset.openTo || '20:00'),
    days: (calendarEl.dataset.openDays || '0,1,2,3,4,5,6').split(',').filter(Boolean).map(Number),
  };

  let currentEvent = null;
  let returnFocus = null;
  let formMode = null; // 'new' | 'edit'

  const calendar = new FullCalendar.Calendar(calendarEl, {
    locale: 'nb',
    initialView: window.matchMedia('(max-width: 700px)').matches ? 'listWeek' : 'timeGridWeek',
    initialDate: params.get('dato') || undefined,
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,timeGridDay,listWeek' },
    buttonText: { listWeek: 'Liste' },
    height: 'auto',
    allDaySlot: false,
    nowIndicator: true,
    slotMinTime: toHHMM(Math.floor(Math.min(rules.from, 7 * 60) / 60) * 60),
    slotMaxTime: toHHMM(Math.ceil(Math.max(rules.to, 19 * 60) / 60) * 60),
    snapDuration: '00:15:00',
    businessHours: { daysOfWeek: rules.days, startTime: toHHMM(rules.from), endTime: toHHMM(rules.to) },
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    dayHeaderFormat: { weekday: 'short', day: 'numeric' },
    noEventsContent: 'Ingen bookinger i denne perioden',
    // Bare roller som kan endre bookinger, kan velge tid eller dra møter.
    selectable: canManage,
    selectMirror: true,
    selectOverlap: false,
    selectAllow: (info) => info.start >= new Date(Date.now() - 15 * 60000),
    editable: canManage,
    eventOverlap: false,
    events(info, success, failure) {
      fetch(`/admin/api/rooms/${roomId}/events?start=${encodeURIComponent(info.startStr)}&end=${encodeURIComponent(info.endStr)}`)
        .then((r) => {
          if (r.redirected || !r.ok) throw new Error();
          return r.json();
        })
        .then(success)
        .catch(() => {
          failure();
          UI.toast('Kunne ikke hente bookinger. Er du fortsatt logget inn?', { type: 'alert' });
        });
    },
    eventDidMount(info) {
      info.el.style.setProperty('--c', info.event.extendedProps.color);
    },
    eventContent(arg) {
      const p = arg.event.extendedProps;
      if (p.blocked) return { domNodes: [document.createTextNode(arg.event.title)] };
      const marker = p.seriesId ? ' ↻' : '';
      if (arg.view.type === 'listWeek') {
        const wrap = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = arg.event.title + marker;
        wrap.append(strong, ` · ${p.organizerName}${p.status === 'pending' ? ' · venter på bekreftelse' : ''}`);
        return { domNodes: [wrap] };
      }
      const time = document.createElement('div');
      time.className = 'fc-event-time';
      time.textContent = arg.timeText + marker;
      const title = document.createElement('div');
      title.className = 'fc-event-title';
      title.textContent = arg.event.title;
      const who = document.createElement('div');
      who.textContent = p.status === 'pending' ? `${p.organizerName} (ubekreftet)` : p.organizerName;
      return { domNodes: [time, title, who] };
    },
    eventClick(info) {
      info.jsEvent.preventDefault();
      if (info.event.extendedProps.blocked) {
        window.location.href = '/admin/sperringer';
        return;
      }
      openView(info.event);
    },
    // Å dra eller strekke et møte åpner skjemaet med den nye tiden; ingenting lagres før man trykker Lagre.
    eventDrop: (info) => proposeMove(info),
    eventResize: (info) => proposeMove(info),
    select(info) {
      calendar.unselect();
      openForm('new', null, { start: info.start, end: info.end });
    },
  });
  calendar.render();

  // Behold datoen i kalenderen når man bytter rom.
  document.querySelectorAll('.room-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      tab.href = `${tab.getAttribute('href').split('&')[0]}&dato=${toDateValue(calendar.getDate())}`;
    });
  });

  // En booking gjort i forhåndsvisningen skal vises med en gang modalen lukkes.
  document.addEventListener('preview:closed', () => calendar.refetchEvents());

  // --- Skuffen ---

  function setBackgroundInert(value) {
    document.querySelectorAll('body > header, body > main').forEach((el) => {
      el.inert = value;
    });
  }

  function showDrawer() {
    if (!drawer.hasAttribute('data-open')) returnFocus = document.activeElement;
    overlay.setAttribute('data-open', '');
    drawer.setAttribute('data-open', '');
    setBackgroundInert(true);
  }

  function closeDrawer() {
    overlay.removeAttribute('data-open');
    drawer.removeAttribute('data-open');
    setBackgroundInert(false);
    currentEvent = null;
    formMode = null;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }

  closeBtn.addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.hasAttribute('data-open')) closeDrawer();
  });

  const STATUS = {
    confirmed: 'Bekreftet',
    pending: 'Venter på at den som booket bekrefter via e-post',
  };

  function openView(event) {
    currentEvent = event;
    const p = event.extendedProps;
    view.hidden = false;
    if (form) form.hidden = true;
    document.getElementById('drawerEyebrow').textContent = p.createdByAdmin ? 'Booket av administrator' : 'Booking';
    document.getElementById('drawerTitle').textContent = event.title;
    document.getElementById('dWhen').textContent = fmtRange(event.start, event.end);
    document.getElementById('dRoom').textContent = p.roomName;
    document.getElementById('dStatus').textContent = STATUS[p.status] || p.status;
    document.getElementById('dStatusWrap').hidden = p.status === 'confirmed';
    document.getElementById('dSeries').textContent = p.seriesLabel || '';
    document.getElementById('dSeriesWrap').hidden = !p.seriesId;
    document.getElementById('dName').textContent = p.organizerName;
    const email = document.getElementById('dEmail');
    email.textContent = p.organizerEmail;
    email.href = `mailto:${encodeURIComponent(p.organizerEmail).replace('%40', '@')}`;
    document.getElementById('dNotesWrap').hidden = !p.notes;
    document.getElementById('dNotes').textContent = p.notes || '';

    const past = event.end < new Date();
    if (cancelBtn) {
      resetCancel();
      cancelBtn.disabled = past;
    }
    if (cancelSeriesBtn) {
      resetCancelSeries();
      cancelSeriesBtn.hidden = !p.seriesId || past;
    }
    if (editBtn) editBtn.disabled = past;
    showDrawer();
    closeBtn.focus();
  }

  async function cancel(scope, button) {
    if (!currentEvent) return;
    const event = currentEvent;
    button.disabled = true;
    button.textContent = 'Avlyser …';
    try {
      const res = await fetch(`/admin/api/bookings/${event.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || res.redirected) throw new Error(data.error);
      closeDrawer();
      calendar.refetchEvents();
      const what = data.cancelled > 1 ? `${data.cancelled} møter i «${event.title}» er avlyst.` : `«${event.title}» er avlyst.`;
      UI.toast(
        data.mailSent
          ? `${what} ${event.extendedProps.organizerName} har fått beskjed på e-post.`
          : `${what} E-post ble ikke sendt, så gi gjerne beskjed selv.`
      );
    } catch (err) {
      UI.toast((err && err.message) || 'Kunne ikke avlyse. Prøv igjen.', { type: 'alert' });
    } finally {
      button.disabled = false;
    }
  }

  // Knappene finnes bare for roller som kan endre bookinger.
  const resetCancel = cancelBtn ? UI.confirmButton(cancelBtn, (_e, reset) => cancel('one', cancelBtn).then(reset)) : () => {};
  const resetCancelSeries = cancelSeriesBtn
    ? UI.confirmButton(cancelSeriesBtn, (_e, reset) => cancel('series', cancelSeriesBtn).then(reset))
    : () => {};
  if (editBtn) editBtn.addEventListener('click', () => openForm('edit', currentEvent));

  // --- Skjema: ny booking på vegne av noen, eller endring ---

  if (!form) return;
  const alertBox = document.getElementById('adminFormAlert');
  const movedNote = document.getElementById('movedNote');
  const submitBtn = document.getElementById('formSubmitBtn');
  const repeat = form.repeat;
  const untilField = document.getElementById('fUntilField');
  const skipField = document.getElementById('fSkipField');

  function showError(message) {
    alertBox.innerHTML = `<div class="alert alert-error">${UI.icon('alert')}<span></span></div>`;
    alertBox.querySelector('span').textContent = message;
  }

  function updateRepeat() {
    const on = repeat.value !== 'none';
    untilField.hidden = !on;
    skipField.hidden = !on;
    if (on && !form.repeatUntil.value && form.date.value) {
      const d = new Date(`${form.date.value}T12:00`);
      d.setDate(d.getDate() + 28);
      form.repeatUntil.value = toDateValue(d);
    }
  }
  repeat.addEventListener('change', updateRepeat);

  function defaultRange() {
    const start = new Date();
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() < 30 ? 30 : 60);
    return { start, end: new Date(start.getTime() + 60 * 60000) };
  }

  function openForm(mode, event, range = null) {
    formMode = mode;
    currentEvent = event;
    alertBox.innerHTML = '';
    const p = event ? event.extendedProps : {};
    const { start, end } = range || (event ? { start: event.start, end: event.end } : defaultRange());

    form.roomId.value = mode === 'edit' ? p.roomId : roomId;
    form.date.value = toDateValue(start);
    form.startTime.value = toTimeValue(start);
    form.endTime.value = toTimeValue(end);
    form.title.value = event ? event.title : '';
    form.organizerName.value = p.organizerName || '';
    form.organizerEmail.value = p.organizerEmail || '';
    form.notes.value = p.notes || '';
    form.notify.checked = true;
    repeat.value = 'none';
    form.repeatUntil.value = '';
    updateRepeat();
    form.querySelector('.new-only').hidden = mode !== 'new';
    document.getElementById('fNotifyLabel').textContent =
      mode === 'new' ? 'Send kalenderinvitasjon til personen' : 'Send oppdatert invitasjon til personen';

    movedNote.hidden = !(mode === 'edit' && range);
    if (mode === 'edit' && range) movedNote.textContent = `Flyttes fra ${fmtRange(event.start, event.end)}. Sjekk og lagre.`;

    document.getElementById('drawerEyebrow').textContent = mode === 'new' ? 'Book på vegne av noen' : 'Endre booking';
    document.getElementById('drawerTitle').textContent = mode === 'new' ? 'Ny booking' : event.title;
    submitBtn.textContent = mode === 'new' ? 'Book' : 'Lagre endringer';
    view.hidden = true;
    form.hidden = false;
    showDrawer();
    (mode === 'new' && !form.title.value ? form.title : form.date).focus();
  }

  function proposeMove(info) {
    const { start, end } = info.event;
    info.revert();
    openForm('edit', calendar.getEventById(info.event.id) || info.event, { start, end });
  }

  const newBtn = document.getElementById('newBookingBtn');
  if (newBtn) newBtn.addEventListener('click', () => openForm('new', null));
  document.getElementById('formCancelBtn').addEventListener('click', () => {
    if (formMode === 'edit' && currentEvent) openView(currentEvent);
    else closeDrawer();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';
    const start = new Date(`${form.date.value}T${form.startTime.value}`);
    const end = new Date(`${form.date.value}T${form.endTime.value}`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return showError('Velg dato og tidspunkt.');
    if (end <= start) return showError('Sluttid må være etter starttid.');
    if (!form.title.value.trim()) return showError('Skriv kort hva møtet gjelder.');
    if (!form.organizerName.value.trim()) return showError('Skriv inn navnet til den du booker for.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.organizerEmail.value.trim())) return showError('Sjekk e-postadressen.');

    const body = {
      title: form.title.value.trim(),
      organizerName: form.organizerName.value.trim(),
      organizerEmail: form.organizerEmail.value.trim(),
      notes: form.notes.value.trim(),
      start: start.toISOString(),
      end: end.toISOString(),
      notify: form.notify.checked,
    };
    const targetRoom = form.roomId.value;
    const roomName = form.roomId.selectedOptions[0].textContent;
    let url;
    let method;
    if (formMode === 'new') {
      Object.assign(body, { repeat: repeat.value, repeatUntil: form.repeatUntil.value, skipConflicts: form.skipConflicts.checked });
      url = `/admin/api/rooms/${targetRoom}/bookings`;
      method = 'POST';
    } else {
      body.roomId = targetRoom;
      url = `/admin/api/bookings/${currentEvent.id}`;
      method = 'PATCH';
    }

    submitBtn.disabled = true;
    const label = submitBtn.textContent;
    submitBtn.textContent = 'Lagrer …';
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.redirected) throw new Error('Du er logget ut. Last siden på nytt.');
      if (!res.ok) throw new Error(data.error || 'Kunne ikke lagre. Prøv igjen.');

      const otherRoom = String(targetRoom) !== String(roomId);
      const mode = formMode;
      closeDrawer();
      calendar.refetchEvents();
      let text;
      if (mode === 'new') {
        text = data.count > 1 ? `${data.count} møter er booket` : 'Møtet er booket';
        if (otherRoom) text += ` i ${roomName}`;
        text += '.';
        if (data.skipped && data.skipped.length) text += ` ${data.skipped.length} dato(er) ble hoppet over fordi de var opptatt.`;
      } else {
        text = otherRoom ? `Møtet er flyttet til ${roomName}.` : 'Endringen er lagret.';
      }
      if (body.notify) text += data.mailSent ? ' Personen har fått e-post.' : ' E-post ble ikke sendt.';
      UI.toast(text);
    } catch (err) {
      showError(err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = label;
    }
  });
})();

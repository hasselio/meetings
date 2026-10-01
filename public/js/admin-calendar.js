(function () {
  const calendarEl = document.getElementById('calendar');
  const roomId = calendarEl.dataset.roomId;
  const overlay = document.getElementById('overlay');
  const drawer = document.getElementById('drawer');
  const closeBtn = document.getElementById('drawerClose');
  const cancelBtn = document.getElementById('cancelBookingBtn');

  const fmtDay = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtTime = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const params = new URLSearchParams(location.search);

  let currentEvent = null;
  let returnFocus = null;

  const calendar = new FullCalendar.Calendar(calendarEl, {
    locale: 'nb',
    initialView: window.matchMedia('(max-width: 700px)').matches ? 'listWeek' : 'timeGridWeek',
    initialDate: params.get('dato') || undefined,
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,timeGridDay,listWeek' },
    buttonText: { listWeek: 'Liste' },
    height: 'auto',
    allDaySlot: false,
    nowIndicator: true,
    slotMinTime: '07:00:00',
    slotMaxTime: '20:00:00',
    businessHours: { daysOfWeek: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '17:00' },
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    dayHeaderFormat: { weekday: 'short', day: 'numeric' },
    noEventsContent: 'Ingen bookinger i denne perioden',
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
      if (arg.view.type === 'listWeek') {
        const wrap = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = arg.event.title;
        wrap.append(strong, ` · ${arg.event.extendedProps.organizerName}`);
        return { domNodes: [wrap] };
      }
      const time = document.createElement('div');
      time.className = 'fc-event-time';
      time.textContent = arg.timeText;
      const title = document.createElement('div');
      title.className = 'fc-event-title';
      title.textContent = arg.event.title;
      const who = document.createElement('div');
      who.textContent = arg.event.extendedProps.organizerName;
      return { domNodes: [time, title, who] };
    },
    eventClick(info) {
      info.jsEvent.preventDefault();
      openDrawer(info.event);
    },
  });
  calendar.render();

  // Behold datoen i kalenderen når man bytter rom.
  document.querySelectorAll('.room-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const d = calendar.getDate();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      tab.href = `${tab.getAttribute('href').split('&')[0]}&dato=${iso}`;
    });
  });

  function openDrawer(event) {
    currentEvent = event;
    returnFocus = document.activeElement;
    const p = event.extendedProps;
    document.getElementById('drawerTitle').textContent = event.title;
    document.getElementById('dWhen').textContent =
      `${fmtDay.format(event.start)}, ${fmtTime.format(event.start)}–${fmtTime.format(event.end)}`;
    document.getElementById('dRoom').textContent = p.roomName;
    document.getElementById('dName').textContent = p.organizerName;
    const email = document.getElementById('dEmail');
    email.textContent = p.organizerEmail;
    email.href = `mailto:${encodeURIComponent(p.organizerEmail).replace('%40', '@')}`;
    document.getElementById('dNotesWrap').hidden = !p.notes;
    document.getElementById('dNotes').textContent = p.notes || '';
    resetCancel();
    cancelBtn.disabled = event.end < new Date();
    overlay.setAttribute('data-open', '');
    drawer.setAttribute('data-open', '');
    setBackgroundInert(true);
    closeBtn.focus();
  }

  function setBackgroundInert(value) {
    document.querySelectorAll('body > header, body > main').forEach((el) => {
      el.inert = value;
    });
  }

  function closeDrawer() {
    overlay.removeAttribute('data-open');
    drawer.removeAttribute('data-open');
    setBackgroundInert(false);
    currentEvent = null;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }

  closeBtn.addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.hasAttribute('data-open')) closeDrawer();
  });

  const resetCancel = UI.confirmButton(cancelBtn, async (_e, reset) => {
    if (!currentEvent) return;
    const event = currentEvent;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Avlyser …';
    try {
      const res = await fetch(`/admin/api/bookings/${event.id}/cancel`, { method: 'POST' });
      if (!res.ok || res.redirected) throw new Error();
      const data = await res.json();
      closeDrawer();
      calendar.refetchEvents();
      UI.toast(
        data.mailSent
          ? `«${event.title}» er avlyst. ${event.extendedProps.organizerName} har fått beskjed på e-post.`
          : `«${event.title}» er avlyst. E-post kunne ikke sendes, så gi gjerne beskjed selv.`
      );
    } catch (_) {
      UI.toast('Kunne ikke avlyse møtet. Prøv igjen.', { type: 'alert' });
    } finally {
      cancelBtn.disabled = false;
      reset();
    }
  });
})();

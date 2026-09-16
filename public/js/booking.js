(function () {
  const roomId = document.body.dataset.roomId;
  const calendarEl = document.getElementById('calendar');
  const modal = document.getElementById('bookingModal');
  const form = document.getElementById('bookingForm');
  const formError = document.getElementById('formError');

  function toLocalInputValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function openModal(start, end) {
    formError.innerHTML = '';
    form.reset();
    if (start) form.start.value = toLocalInputValue(start);
    if (end) form.end.value = toLocalInputValue(end);
    modal.classList.add('open');
  }

  function closeModal() {
    modal.classList.remove('open');
  }

  const calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: 'timeGridWeek',
    height: 'auto',
    nowIndicator: true,
    selectable: true,
    slotMinTime: '06:00:00',
    slotMaxTime: '20:00:00',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,timeGridDay' },
    events: function (info, successCallback, failureCallback) {
      fetch(`/api/rooms/${roomId}/events?start=${encodeURIComponent(info.startStr)}&end=${encodeURIComponent(info.endStr)}`)
        .then((r) => r.json())
        .then(successCallback)
        .catch(failureCallback);
    },
    select: function (info) {
      openModal(info.start, info.end);
    },
  });
  calendar.render();

  document.getElementById('bookBtn').addEventListener('click', () => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    openModal(start, end);
  });

  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    formError.innerHTML = '';

    const payload = {
      title: form.title.value,
      organizerName: form.organizerName.value,
      organizerEmail: form.organizerEmail.value,
      notes: form.notes.value,
      start: new Date(form.start.value).toISOString(),
      end: new Date(form.end.value).toISOString(),
    };

    fetch(`/api/rooms/${roomId}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Noe gikk feil');
        return data;
      })
      .then(() => {
        closeModal();
        calendar.refetchEvents();
        alert('Møtet er booket! Du får en bekreftelse på e-post med kalenderinvitasjon.');
      })
      .catch((err) => {
        formError.innerHTML = `<div class="error-message">${err.message}</div>`;
      });
  });
})();

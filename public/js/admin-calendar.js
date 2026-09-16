(function () {
  const rooms = window.ROOMS || [];
  if (rooms.length === 0) return;

  const calendarEl = document.getElementById('calendar');
  const roomMeta = document.getElementById('roomMeta');
  const editRoomLink = document.getElementById('editRoomLink');
  const deleteRoomForm = document.getElementById('deleteRoomForm');
  const timezone = document.body.dataset.timezone;

  const detailsModal = document.getElementById('detailsModal');
  const cancelBookingBtn = document.getElementById('cancelBookingBtn');
  let currentBookingId = null;

  function fmt(dateStr) {
    return new Date(dateStr).toLocaleString('nb-NO', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
  }

  let activeRoomId = rooms[0].id;

  function updateRoomPanel() {
    const room = rooms.find((r) => String(r.id) === String(activeRoomId));
    if (!room) return;
    roomMeta.textContent = `${room.name}${room.location ? ' · ' + room.location : ''}${room.capacity ? ' · ' + room.capacity + ' personer' : ''}`;
    editRoomLink.href = `/admin/rooms/${room.id}/edit`;
    deleteRoomForm.action = `/admin/rooms/${room.id}/delete`;
  }

  const calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: 'timeGridWeek',
    height: 'auto',
    nowIndicator: true,
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,timeGridDay,dayGridMonth' },
    events: function (info, successCallback, failureCallback) {
      fetch(`/admin/api/rooms/${activeRoomId}/events?start=${encodeURIComponent(info.startStr)}&end=${encodeURIComponent(info.endStr)}`)
        .then((r) => r.json())
        .then(successCallback)
        .catch(failureCallback);
    },
    eventClick: function (info) {
      const props = info.event.extendedProps;
      currentBookingId = info.event.id;
      document.getElementById('detailsTitle').textContent = info.event.title;
      document.getElementById('detailsOrganizer').textContent = props.organizerName;
      document.getElementById('detailsEmail').textContent = props.organizerEmail;
      document.getElementById('detailsTime').textContent = `${fmt(info.event.startStr)} – ${fmt(info.event.endStr)}`;
      const notesWrap = document.getElementById('detailsNotesWrap');
      if (props.notes) {
        notesWrap.style.display = '';
        document.getElementById('detailsNotes').textContent = props.notes;
      } else {
        notesWrap.style.display = 'none';
      }
      detailsModal.classList.add('open');
    },
  });
  calendar.render();
  updateRoomPanel();

  document.querySelectorAll('.room-tab').forEach((tab) => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.room-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      activeRoomId = tab.dataset.roomId;
      updateRoomPanel();
      calendar.refetchEvents();
    });
  });

  document.getElementById('closeDetailsBtn').addEventListener('click', () => {
    detailsModal.classList.remove('open');
  });
  detailsModal.addEventListener('click', (e) => {
    if (e.target === detailsModal) detailsModal.classList.remove('open');
  });

  cancelBookingBtn.addEventListener('click', () => {
    if (!currentBookingId) return;
    if (!confirm('Avlyse dette møtet? Booker vil få en avlysning på e-post.')) return;
    fetch(`/admin/api/bookings/${currentBookingId}/cancel`, { method: 'POST' })
      .then((r) => r.json())
      .then(() => {
        detailsModal.classList.remove('open');
        calendar.refetchEvents();
      })
      .catch(() => alert('Kunne ikke avlyse møtet.'));
  });
})();

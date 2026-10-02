// Felles kontroll av feltene i en booking, for det offentlige skjemaet, lenken i e-posten og admin.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LIMITS = { title: 120, organizerName: 80, organizerEmail: 120, notes: 500 };

const clean = (value, max) => String(value ?? '').replace(/\s+/g, (m) => (m.includes('\n') ? m : ' ')).trim().slice(0, max);

function bookingFields(body, { requireContact = true } = {}) {
  const values = {
    title: clean(body.title, LIMITS.title),
    organizerName: clean(body.organizerName, LIMITS.organizerName),
    organizerEmail: clean(body.organizerEmail, LIMITS.organizerEmail).toLowerCase(),
    notes: String(body.notes ?? '').trim().slice(0, LIMITS.notes),
  };
  let error = null;
  if (!values.title) error = 'Skriv kort hva møtet gjelder.';
  else if (requireContact && !values.organizerName) error = 'Skriv inn navnet ditt.';
  else if (requireContact && !EMAIL_RE.test(values.organizerEmail)) error = 'Sjekk at e-postadressen er riktig.';
  return { values, error };
}

module.exports = { bookingFields, EMAIL_RE, LIMITS };

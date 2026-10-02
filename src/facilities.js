// Rekkefølgen her er også rekkefølgen fasilitetene vises i.
const FACILITIES = [
  { key: 'screen', label: 'Skjerm', icon: 'monitor' },
  { key: 'teams', label: 'Teams-oppsett', hint: 'kamera, mikrofon og høyttaler', icon: 'video' },
  { key: 'wireless', label: 'Trådløs skjermdeling', icon: 'cast' },
  { key: 'cable', label: 'HDMI/USB-C-kabel', icon: 'plug' },
  { key: 'projector', label: 'Prosjektor', icon: 'projector' },
  { key: 'whiteboard', label: 'Tavle', hint: 'whiteboard', icon: 'whiteboard' },
  { key: 'flipchart', label: 'Flippover', icon: 'easel' },
  { key: 'coffee', label: 'Kaffeautomat', icon: 'coffee' },
  { key: 'water', label: 'Vann', icon: 'droplet' },
  { key: 'accessible', label: 'Universelt utformet', hint: 'trinnfri adkomst', icon: 'accessible' },
  { key: 'daylight', label: 'Dagslys', icon: 'sun' },
];

const BY_KEY = new Map(FACILITIES.map((f) => [f.key, f]));

function normalize(keys) {
  const wanted = new Set([].concat(keys || []));
  return FACILITIES.filter((f) => wanted.has(f.key)).map((f) => f.key);
}

function parse(json) {
  try {
    return normalize(JSON.parse(json || '[]'));
  } catch (_) {
    return [];
  }
}

const describe = (keys) => keys.map((k) => BY_KEY.get(k)).filter(Boolean);

module.exports = { FACILITIES, normalize, parse, describe };

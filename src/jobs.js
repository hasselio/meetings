const { deleteExpiredSessions } = require('./session-store');
const audit = require('./audit');
const config = require('./config');
const maintenance = require('./services/maintenance');

const INTERVAL_MS = 10 * 60 * 1000;

// Oppgaver som kjøres jevnlig. Hver oppgave feiler for seg, så én feil stopper ikke de andre.
const tasks = [
  ['utløpte innlogginger', deleteExpiredSessions],
  ['gammel revisjonslogg', () => audit.deleteOlderThan(config.auditRetentionMonths)],
  ['påminnelser', () => maintenance.sendReminders()],
  ['ubekreftede bookinger', () => maintenance.deleteStalePending()],
  ['sletting av personopplysninger', () => maintenance.applyRetention()],
];

function register(name, fn) {
  tasks.push([name, fn]);
}

async function runJobs() {
  for (const [name, fn] of tasks) {
    try {
      await fn();
    } catch (err) {
      console.error(`[jobs] ${name} feilet:`, err);
    }
  }
}

function startJobs() {
  runJobs();
  setInterval(runJobs, INTERVAL_MS).unref();
}

module.exports = { register, runJobs, startJobs };

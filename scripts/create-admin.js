#!/usr/bin/env node
// Oppretter en administrator direkte i databasen, eller setter nytt passord for en som finnes.
// Bruk på serveren: npm run create-admin
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { AdminUsers } = require('../src/models');

const MIN_PASSWORD_LENGTH = 10;

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Skriv bare ut spørsmålet, ikke tegnene som tastes inn.
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('Kjør kommandoen i en terminal, slik at passordet kan tastes inn skjult.');
    process.exit(1);
  }

  const username = (await ask('Brukernavn: ')).trim();
  if (!/^[\w.@-]{3,40}$/.test(username)) {
    console.error('Brukernavnet må være 3–40 tegn: bokstaver, tall, punktum, @, - eller _.');
    process.exit(1);
  }

  const existing = AdminUsers.findByUsername(username);
  if (existing) {
    const answer = (await ask(`«${username}» finnes allerede. Sette nytt passord? (j/n): `)).trim().toLowerCase();
    if (answer !== 'j' && answer !== 'ja') {
      console.log('Avbrutt. Ingenting er endret.');
      return;
    }
  }

  const password = await ask(`Passord (minst ${MIN_PASSWORD_LENGTH} tegn): `, { hidden: true });
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Passordet må være minst ${MIN_PASSWORD_LENGTH} tegn.`);
    process.exit(1);
  }
  const confirm = await ask('Gjenta passord: ', { hidden: true });
  if (password !== confirm) {
    console.error('Passordene er ikke like.');
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  if (existing) {
    // Logger også ut alle aktive økter for kontoen.
    AdminUsers.setPassword(existing.id, passwordHash);
    console.log(`Nytt passord er satt for «${username}». Eventuelle innlogginger er avsluttet.`);
  } else {
    const name = (await ask('Navn (valgfritt): ')).trim();
    const email = (await ask('E-post (valgfritt): ')).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.error('Ugyldig e-postadresse. Kontoen ble ikke opprettet.');
      process.exit(1);
    }
    AdminUsers.create({ username, passwordHash, name, email });
    console.log(`Administrator «${username}» er opprettet. Logg inn på /admin/login.`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

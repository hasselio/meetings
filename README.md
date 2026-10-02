# Møteromsbooking

Møteromsbooking for hosting på f.eks. en Raspberry Pi. Eksterne og interne ser ledig/opptatt og booker selv; de som forvalter rommene, har et eget admingrensesnitt. Flere bedrifter kan dele løsningen: hver bedrift har sine egne rom og sin egen brukergruppe, og kan ikke se eller endre andres.

Bygget med Node.js, Express og SQLite (better-sqlite3). Det trengs ingen ekstern database eller byggesteg, og alt (fonter, kalender, robot-sjekk) er selv-hostet.

## Funksjoner

### Bedrifter og hierarki

```
Plattform            Plattformadministratorer: oppretter og deaktiverer bedrifter, utnevner deres
   │                 første administrator, kan gå inn i alle bedrifter, ser samlet revisjonslogg.
   ├── Acme AS       Egen brukergruppe (Administrator / Romansvarlig / Lesetilgang), egne rom,
   │                 bookinger, sperringer, rapporter og logg.
   └── Beta AS       Ser og endrer bare sitt eget.
```

- **Hver bedrift eier sine rom.** Alle oppslag i admin går gjennom den aktive bedriften. Forsøk på å nå et rom, en booking, en sperring, en bruker eller en søknad i en annen bedrift gir «finnes ikke» (404), så man kan ikke engang se at det finnes. Et møte kan bare flyttes til et rom i samme bedrift.
- **Én bruker kan være med i flere bedrifter**, med egen rolle i hver, og bytter bedrift i linjen under toppmenyen.
- **Kontoopplysninger og passord** gjelder på tvers av bedrifter. En bedriftsadministrator kan derfor bare endre dem, eller tilbakestille passord, for kontoer som utelukkende tilhører egen bedrift. Ellers kunne én bedrift låse ute en bruker i en annen. Rollen i egen bedrift kan alltid endres.
- **Ingen bedrift kan stå uten administrator**, og det må alltid finnes minst én plattformadministrator.
- **Deaktiverte bedrifter** forsvinner fra den offentlige siden, rommene kan ikke bookes, og brukerne logges ut. Ingenting slettes. Bare bedrifter uten rom kan slettes helt.
- **Nye brukere:**
  - De kan be om tilgang på `/admin/be-om-tilgang` og velge bedrift; lenken `/admin/be-om-tilgang?bedrift=acme-as` velger bedriften på forhånd. Søknaden går til bedriftens administratorer.
  - Bedriftens administrator kan også opprette brukere direkte, med midlertidig passord.
  - Innloggede brukere kan be om tilgang til flere bedrifter under «Min konto».
  - Plattformadministratorer kan legge en eksisterende bruker til i en bedrift.
- **Revisjonsloggen** føres per bedrift. Innlogginger og endringer i bedrifter og plattformadministratorer føres på plattformnivå.

### For de som booker (`/`)

- **Felles forside** med rom fra alle aktive bedrifter og filter per bedrift, og en **egen side per bedrift** (`/b/acme-as`) som bare viser deres rom. Romsiden og e-postene viser hvilken bedrift rommet tilhører.
- **Finn rom:** søk på navn og sted, filtrer på antall personer og fasiliteter, og se hvilke rom som er ledige i et bestemt tidsrom. Romsiden fylles ut med tiden man søkte på.
- **Kalender per rom** med bare ledig/opptatt, og rommets regler (åpningstid, dager, maks varighet osv.).
- **Booking** av enkeltmøter eller **gjentakende møter** (hver ukedag, hver uke eller annenhver uke, maks 26 møter). Opptatte datoer kan hoppes over.
- **Bekreftelse på e-post:** bookingen holder av tiden i 30 minutter og gjelder først når den som booket har bekreftet via lenken i e-posten. Det stopper bookinger i andres navn. (Krever SMTP. Uten SMTP gjelder bookingen med en gang.)
- **Endre eller avbestille via lenken** i e-posten, også enkeltmøter i en serie. Lenken lagres aldri i klartekst, og alle handlinger er knapper (POST), så lenkesjekkere i e-postprogrammer ikke kan bekrefte eller avbestille.
- **Kalenderinvitasjon** (.ics) med tidssone, oppdateringer ved endring og avlysning ved avbestilling. Serier sendes som én avtale med gjentakelse.
- **Påminnelse dagen før** møtet, med lenke for å avbestille.
- **Abonnement på ledig/opptatt** per rom (webcal/iCal) i Outlook, Google eller Apple Kalender. Abonnementet viser aldri hvem som har booket.
- **Beskyttelse mot misbruk:** robot-sjekk ([ALTCHA](https://altcha.org), selv-hostet), skjult felt for roboter, maks 20 bookinger per IP per time og maks 3 ubekreftede bookinger per e-postadresse.
- **Personvernerklæring** på `/personvern`, lenket fra bunnen av alle sider.

### For de som forvalter rommene (`/admin`)

- **Bookinger:** kalender per rom med alle detaljer.
  - Book på vegne av andre med «Ny booking» eller ved å dra over en ledig tid. Serier og valg om å sende invitasjon er med.
  - Flytt et møte ved å dra eller strekke det. Skjemaet åpnes med den nye tiden, og ingenting lagres før man trykker Lagre.
  - Endre rom, tid, tittel, navn, e-post og notat.
  - Avlys ett møte eller hele serien.
  - Ubekreftede bookinger vises skravert.
- **Rom:**
  - Navn, plassering, kapasitet, beskrivelse og fasiliteter.
  - **Regler per rom:** dager, åpningstid, maks varighet, hvor langt frem man kan booke og pause mellom møter. Administratorer kan booke utenfor reglene, men aldri oppå andre bookinger eller sperringer.
  - **Sperrede perioder** for ett rom eller alle, f.eks. ved oppussing, med valg om å avlyse bookinger i perioden og varsle de som har booket.
- **Rapporter:** utnyttelsesgrad per rom (bookede timer delt på åpne timer minus sperringer), antall bookinger, avlysninger og fordeling per ukedag. Utnyttelse og bookinger kan eksporteres som CSV for Excel.
- **Tilgang og roller** (gjelder innenfor én bedrift):

  | Rolle | Kan |
  | --- | --- |
  | Administrator | Alt i bedriften, inkludert brukere, revisjonslogg og sletting av personopplysninger |
  | Romansvarlig | Bookinger, rom, regler, sperringer, rapporter og CSV-eksport |
  | Lesetilgang | Se bookinger, rom og rapporter, uten å endre noe |

  Rollen velges når en søknad godkjennes eller en bruker opprettes. Brukere kan få endret rolle, få tilbakestilt passord (må velge nytt ved neste innlogging) eller fjernes fra bedriften. Kontoen slettes når den ikke lenger er med i noen bedrift.
- **Revisjonslogg:** hvem som gjorde hva og når: bookinger, rom, sperringer, tilganger, innlogginger og eksport. Loggen kan filtreres.
- **Innsyn og sletting:** finn alle bookinger for en e-postadresse og slett personopplysningene (kommende møter avlyses først).
- **Se som besøkende:** viser den offentlige siden i en modal, akkurat slik besøkende ser den.
- **Lys og mørk modus**, og innlogginger som overlever omstart av tjenesten.

## Kom i gang

1. Installer Node.js 20 eller nyere (anbefalt 22 LTS). Versjonen i Raspberry Pi OS sin `apt` er ofte for gammel, så bruk [nvm](https://github.com/nvm-sh/nvm) eller [NodeSource](https://github.com/nodesource/distributions).
2. Installer avhengigheter:

   ```bash
   npm ci
   ```

3. Kopier `.env.example` til `.env` og fyll ut. Alle innstillinger er forklart i filen. Disse er viktigst:
   - `SESSION_SECRET` (**påkrevd**): generer med `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Lenkene i e-postene (bekreft/endre/avbestille) avledes også fra denne. Bytter du den, slutter eksisterende lenker å virke.
   - `BASE_URL`: adressen tjenesten nås på. Brukes i lenkene i e-postene og i kalenderabonnementet.
   - `COOKIE_SECURE=true` bak en HTTPS-proxy. Slår også på `trust proxy`, så grensene per IP gjelder besøkeren og ikke proxyen.
   - `SMTP_*` og `MAIL_FROM_*`: uten SMTP fungerer alt, men det sendes ingen e-post, og bookinger gjelder da uten bekreftelse (lenken for å endre/avbestille vises på kvitteringen i stedet).
   - `ADMIN_NOTIFY_EMAIL`: får kopi av invitasjoner og varsel om nye tilgangsforespørsler.
   - `BOOKING_CONFIRMATION`, `PENDING_HOLD_MINUTES`, `REMINDERS`: e-postbekreftelse, holdetid og påminnelser.
   - `RETENTION_MONTHS` (standard 6), `AUDIT_RETENTION_MONTHS` (standard 12), `PRIVACY_CONTACT`: oppbevaringstid og kontaktadresse i personvernerklæringen.

4. Start tjenesten med `npm start`. Den lytter på `127.0.0.1` og porten i `.env`, og er ment å stå bak en reverse proxy med HTTPS. Robot-sjekken krever HTTPS (eller `localhost`).
5. Opprett den første plattformadministratoren på serveren:

   ```bash
   npm run create-admin
   ```

   Samme kommando setter nytt passord hvis brukernavnet finnes fra før, og kan gjøre en eksisterende konto til plattformadministrator. Logg deretter inn, gå til «Plattform» og opprett bedriftene med deres første administrator.

## Oppdatere en eksisterende installasjon

Databasen oppgraderes automatisk ved oppstart. Ved overgangen til flere bedrifter skjer følgende:

- Alle rom, bookinger og brukere flyttes inn i en første bedrift. Den heter `FIRST_ORG_NAME`, standard «Min bedrift», og kan få nytt navn under «Plattform».
- Dagens administratorer blir plattformadministratorer og administratorer i bedriften.
- Romansvarlige og brukere med lesetilgang beholder rollen sin.

Ta likevel backup først:

```bash
cd /srv/www/meetings/repo                  # eller der prosjektet ligger
cp data/mettings.db ~/mettings-$(date +%F).db
git pull
npm ci --omit=dev
sudo systemctl restart meetings
journalctl -u meetings -n 30               # sjekk at den startet
```

## Kjøre som systemd-tjeneste

`/etc/systemd/system/meetings.service`:

```ini
[Unit]
Description=Møteromsbooking
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/srv/www/meetings/repo
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
EnvironmentFile=/srv/www/meetings/repo/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now meetings
journalctl -u meetings -f
```

Påminnelser, opprydding i ubekreftede bookinger, anonymisering og rydding i loggen kjøres av tjenesten selv hvert tiende minutt. Det trengs ingen cron.

## HTTPS og eksponering

Sett opp en reverse proxy med TLS, f.eks. nginx med certbot, eller [Caddy](https://caddyserver.com/):

```
meet.dittdomene.no {
  reverse_proxy localhost:3200
}
```

Videresend bare port 443 (og 80 for Let's Encrypt) til Pi-en.

## Personvern og oppbevaring

- Besøkende ser bare ledig/opptatt. Navn, e-post, tittel og notat ser bare innloggede brukere.
- Ubekreftede bookinger frigis etter holdetiden og slettes etter et døgn.
- Navn, e-post, tittel og notat fjernes automatisk `RETENTION_MONTHS` måneder etter møtet. Rom og tidspunkt beholdes, uten noe som peker på personen, så rapportene fortsatt stemmer. Behandlede tilgangsforespørsler slettes etter like lang tid.
- Revisjonsloggen slettes etter `AUDIT_RETENTION_MONTHS` måneder. Sletting etter ønske logges uten e-postadressen.
- Den offentlige siden setter ingen informasjonskapsler. Navn/e-post og valgt tema huskes bare i besøkerens egen nettleser.
- Personvernerklæringen (`views/public/privacy.ejs`) er et utgangspunkt. Tilpass behandlingsgrunnlag og behandlingsansvarlig til virksomheten.

## Datalagring og backup

All data ligger i `data/mettings.db` (SQLite, ikke i git). Ta backup jevnlig, f.eks.:

```bash
0 3 * * * sqlite3 /srv/www/meetings/repo/data/mettings.db ".backup '/home/pi/backup/mettings-$(date +\%F).db'"
```

## Utvikling og tester

```bash
npm run dev     # starter med automatisk omstart ved endringer
npm test        # kjører testene (node:test + supertest, egen database i minnet)
```

GitHub Actions kjører testene på Node 20 og 22 ved hver push og pull request (`.github/workflows/test.yml`).

## Arkitektur

- `src/services/bookings.js`: all bookinglogikk (regler, sperringer, overlapp, opprettelse, bekreftelse, endring, avlysning), felles for det offentlige skjemaet, lenken i e-posten og admin. Sjekk og lagring skjer i samme databasetransaksjon, så to som booker samtidig ikke kan få samme tid.
- `src/ics.js`: egen iCalendar-generator med VTIMEZONE, gjentakelse (RRULE/EXDATE/RECURRENCE-ID), riktig escaping og linjebretting.
- `src/recurrence.js`: forekomster for serier, regnet i lokal tid, så klokkeslettet holder seg over sommertid/vintertid.
- `src/routes/admin/`: adminrutene, delt opp i bookinger, rom, tilgang, konto, logg/rapporter og plattform. Alt unntatt konto og plattform krever en aktiv bedrift (`req.org`), og bruker oppslag som `Rooms.getInOrg` og `Bookings.getInOrg`.
- `src/middleware/auth.js`: innlogging, aktiv bedrift og rollen i den (`req.admin.role`).
- `src/roles.js` og `src/audit.js`: roller/tillatelser og revisjonslogg.
- `src/jobs.js` og `src/services/maintenance.js`: jevnlige jobber.
- Grensene for antall forsøk ligger i minnet og nullstilles ved omstart. Innlogginger lagres i databasen.
- Frontend bruker [FullCalendar](https://fullcalendar.io/), fonten [Geist](https://vercel.com/font) og [ALTCHA](https://altcha.org), alle selv-hostet under `public/vendor/`.

# Møteromsbooking

Enkel møterom-booking-tjeneste for hosting på f.eks. en Raspberry Pi.

- **Offentlig grensesnitt** (`/`): eksterne og interne kan se ledig/opptatt per møterom i en kalender, og booke et møte. Booker får en møtebekreftelse på e-post med kalenderinvitasjon (.ics).
- **Admin-grensesnitt** (`/admin`) med tre faner:
  - **Bookinger:** kalender per rom med full oversikt (hvem, e-post, tittel, notat) og mulighet til å avlyse et møte (sender avlysning på e-post).
  - **Rom:** legg til, rediger og slett rom, med plassering, kapasitet, beskrivelse og fasiliteter (skjerm, Teams-oppsett, tavle, kaffeautomat osv.). Fasilitetene vises med ikon for de som booker. Sletter du et rom med kommende bookinger, får de som booket avlysning på e-post.
  - **Tilgang:** godkjenn eller avslå nye administratorer.
- **Se som besøkende:** fra menyen, romlisten og redigeringsskjemaet kan en admin åpne den offentlige siden. En smal linje øverst viser at du er i forhåndsvisning, med lenker tilbake til redigering. Innholdet er nøyaktig det besøkende ser.

Bygget med Node.js + Express + SQLite (better-sqlite3) — ingen ekstern database eller build-steg nødvendig, passer godt på en Raspberry Pi.

## Kom i gang (lokalt / på Raspberry Pi)

1. Installer Node.js 20 eller nyere (anbefalt: 22 LTS). Versjonen i Raspberry Pi OS sin `apt` er ofte for gammel, så bruk [nvm](https://github.com/nvm-sh/nvm) eller [NodeSource](https://github.com/nodesource/distributions).
2. Klon/kopier prosjektet til Pi-en, og installer avhengigheter:

   ```bash
   npm install
   ```

3. Kopier `.env.example` til `.env` og fyll ut:

   ```bash
   cp .env.example .env
   ```

   Viktigst:
   - `SESSION_SECRET` – **påkrevd**, tjenesten starter ikke uten den. Generer en tilfeldig verdi med f.eks. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
   - `COOKIE_SECURE` – sett til `true` når tjenesten står bak en TLS-terminerende reverse proxy (se under), slik at innloggingscookien kun sendes over HTTPS. Dette slår også på `trust proxy`, slik at grensene for innloggingsforsøk og tilgangsforespørsler gjelder besøkerens IP og ikke proxyens.
   - `SMTP_*` og `MAIL_FROM_*` – SMTP-konto som skal sende møtebekreftelser (f.eks. et delt e-postalias, eller en transaksjonsepost-tjeneste). Uten SMTP satt opp vil bookinger fortsatt fungere, men det sendes ingen bekreftelse.
   - `BASE_URL` – URL-en tjenesten nås på. Brukes i lenkene i e-poster om admintilgang.
   - `ADMIN_NOTIFY_EMAIL` – får kopi av nye bookinger og varsel når noen ber om admintilgang.
   - `TIMEZONE` – standard `Europe/Oslo`. Brukes for «ledig til / opptatt til» og dagens tidslinje på forsiden.
   - `APP_NAME` – navnet som vises i toppen og i fanen (standard `Møterom`).

4. Start tjenesten:

   ```bash
   npm start
   ```

   Tjenesten kjører nå på `http://127.0.0.1:3000` (eller porten satt i `.env`). Den lytter bare lokalt som standard, siden den er ment å stå bak en reverse proxy. Sett `HOST=0.0.0.0` hvis du vil nå den direkte fra nettverket.

5. Opprett den første administratoren direkte på serveren (passordet tastes inn skjult og lagres kryptert):

   ```bash
   npm run create-admin
   ```

   Samme kommando setter nytt passord hvis brukernavnet finnes fra før, nyttig om noen er låst ute.

6. Logg inn på `/admin` og legg til møterom under «Nytt rom».

## Admintilgang

- Det finnes ingen måte å opprette admin fra nettsiden uten godkjenning. Den første administratoren lages med `npm run create-admin`.
- Andre kan be om tilgang på `/admin/be-om-tilgang` (lenket fra innloggingen). De velger selv brukernavn og passord, og forespørselen havner i kø under **Tilgang** i adminpanelet. Ingen får tilgang før en eksisterende administrator har godkjent.
- Når forespørselen er behandlet, får personen svar på e-post. Passord-hashen slettes fra forespørselen når den er behandlet.
- Under **Tilgang** kan administratorer også fjerne andres tilgang. Den som fjernes, logges ut umiddelbart. Man kan ikke fjerne seg selv eller den siste administratoren.
- Beskyttelse mot roboter og misbruk:
  - [ALTCHA](https://altcha.org) (proof-of-work, selv-hostet, ingen tredjepart eller sporing, MIT-lisens). Nettleseren løser en liten regneoppgave før skjemaet kan sendes, og hver løsning kan bare brukes én gang.
  - Et skjult «honeypot»-felt som bare roboter fyller ut.
  - Maks 5 forespørsler per IP per time, og maks 50 ubehandlede forespørsler i køen.
  - Innlogging: etter 8 feil passord for samme brukernavn fra samme IP stenges forsøk i 15 minutter.
- ALTCHA bruker nettleserens Web Crypto API, som bare er tilgjengelig over HTTPS (eller `localhost`). Skjemaet for å be om tilgang krever derfor at tjenesten nås via HTTPS, se under.

## Kjøre som en systemd-tjeneste på Raspberry Pi

Opprett `/etc/systemd/system/mettings.service`:

```ini
[Unit]
Description=Møteromsbooking
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/Mettings
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
EnvironmentFile=/home/pi/Mettings/.env

[Install]
WantedBy=multi-user.target
```

Aktiver og start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mettings
sudo systemctl status mettings
```

Logger: `journalctl -u mettings -f`

## Eksponering til eksterne brukere (HTTPS)

Siden tjenesten skal deles med eksterne, bør den ikke eksponeres direkte over HTTP. Sett opp en reverse proxy med TLS, f.eks. [Caddy](https://caddyserver.com/) (enkel automatisk HTTPS via Let's Encrypt):

```
booking.dittdomene.no {
  reverse_proxy localhost:3000
}
```

Alternativt nginx + certbot. Sørg for at ruteren/brannmuren kun videresender port 443 (og 80 for Let's Encrypt-utfordringen) til Pi-en.

## Datalagring og backup

All data ligger i `data/mettings.db` (SQLite). Denne filen er ikke sjekket inn i git (se `.gitignore`). Ta backup av denne filen regelmessig, f.eks. med en enkel cron-jobb som kopierer den til et annet sted:

```bash
0 3 * * * cp /home/pi/Mettings/data/mettings.db /home/pi/backup/mettings-$(date +%F).db
```

## Arkitektur / begrensninger i denne MVP-versjonen

- Én admin-rolle: alle administratorer har samme rettigheter, også til å godkjenne nye.
- Grensene for forsøk lagres i minnet og nullstilles ved omstart.
- Sesjoner lagres i minne — en omstart av tjenesten logger ut admin (uproblematisk for et internt verktøy, men kan byttes til en filbasert sesjonslagring senere om ønskelig).
- E-postbekreftelse sendes som en ekte kalenderinvitasjon (`METHOD:REQUEST`), slik at booker kan trykke "Godta" og få møtet inn i sin egen kalender. Avlysning sendes som `METHOD:CANCEL`.
- Overlappende bookinger på samme rom avvises på serversiden.
- Frontend bruker [FullCalendar](https://fullcalendar.io/) (med norsk lokalisering) og fonten [Geist](https://vercel.com/font), begge selv-hostet under `public/vendor/` — ingen internettilgang er nødvendig når tjenesten kjører.
- Grensesnittet følger systemets lys/mørk-modus og respekterer «redusert bevegelse».
- Kalender og bookingskjema viser tider i besøkerens lokale tidssone; kalenderinvitasjonen sendes i UTC, så den havner riktig i mottakerens kalender uansett hvor de befinner seg.

## Videre arbeid (forslag)

- Rollestyring (f.eks. egen rolle som kan godkjenne nye administratorer).
- Bekreftelse av e-postadresse før en tilgangsforespørsel havner i køen.
- Redigering av eksisterende bookinger (i dag kan admin kun avlyse).
- Varsling til internt e-postalias ved nye bookinger (`ADMIN_NOTIFY_EMAIL` i `.env` sender allerede en kopi hvis satt).
- Eksport av bookinger (CSV) for rapportering.

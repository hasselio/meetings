# Møteromsbooking

Enkel møterom-booking-tjeneste for hosting på f.eks. en Raspberry Pi.

- **Offentlig grensesnitt** (`/`): eksterne og interne kan se ledig/opptatt per møterom i en kalender, og booke et møte. Booker får en møtebekreftelse på e-post med kalenderinvitasjon (.ics).
- **Admin-grensesnitt** (`/admin`): innlogget administrasjon av rom, og full oversikt over bookinger (hvem, e-post, tittel, notat) med mulighet til å avlyse et møte (sender avlysning på e-post).

Bygget med Node.js + Express + SQLite (better-sqlite3) — ingen ekstern database eller build-steg nødvendig, passer godt på en Raspberry Pi.

## Kom i gang (lokalt / på Raspberry Pi)

1. Installer Node.js 18+ (på Raspberry Pi OS: `sudo apt install nodejs npm`, eller bruk [nvm](https://github.com/nvm-sh/nvm) for en nyere versjon).
2. Klon/kopier prosjektet til Pi-en, og installer avhengigheter:

   ```bash
   npm install
   ```

3. Kopier `.env.example` til `.env` og fyll ut:

   ```bash
   cp .env.example .env
   ```

   Viktigst:
   - `SESSION_SECRET` – sett til en lang, tilfeldig streng.
   - `SMTP_*` og `MAIL_FROM_*` – SMTP-konto som skal sende møtebekreftelser (f.eks. et delt e-postalias, eller en transaksjonsepost-tjeneste). Uten SMTP satt opp vil bookinger fortsatt fungere, men det sendes ingen bekreftelse.
   - `BASE_URL` – URL-en tjenesten nås på (brukes ikke direkte i e-post ennå, men bør stemme for fremtidig bruk).
   - `TIMEZONE` – standard `Europe/Oslo`.

4. Start tjenesten:

   ```bash
   npm start
   ```

   Tjenesten kjører nå på `http://localhost:3000` (eller porten satt i `.env`).

5. Gå til `/admin` i nettleseren. Første gang blir du bedt om å opprette en admin-bruker (brukernavn + passord). Deretter kan du legge til møterom under "Nytt rom".

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

- Én admin-rolle (ingen forskjellige rettighetsnivåer for flere interne brukere ennå).
- Sesjoner lagres i minne — en omstart av tjenesten logger ut admin (uproblematisk for et internt verktøy, men kan byttes til en filbasert sesjonslagring senere om ønskelig).
- E-postbekreftelse sendes som en ekte kalenderinvitasjon (`METHOD:REQUEST`), slik at booker kan trykke "Godta" og få møtet inn i sin egen kalender. Avlysning sendes som `METHOD:CANCEL`.
- Overlappende bookinger på samme rom avvises på serversiden.
- Frontend bruker [FullCalendar](https://fullcalendar.io/) lastet fra CDN — krever internettilgang for at kalendervisningen skal fungere. Vurder å laste ned biblioteket lokalt (`public/vendor/`) hvis Pi-en kjører uten internett.

## Videre arbeid (forslag)

- Flere admin-brukere / rollestyring.
- Redigering av eksisterende bookinger (i dag kan admin kun avlyse).
- Varsling til internt e-postalias ved nye bookinger (`ADMIN_NOTIFY_EMAIL` i `.env` sender allerede en kopi hvis satt).
- Eksport av bookinger (CSV) for rapportering.

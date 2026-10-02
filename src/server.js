const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
require('./db'); // sikrer at tabeller finnes ved oppstart

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Bare appen selv får vise sidene i en ramme (forhåndsvisningen); hindrer clickjacking fra andre nettsteder.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

if (config.cookieSecure) {
  app.set('trust proxy', 1); // nødvendig for secure-cookies bak en TLS-terminerende reverse proxy
}

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12, // 12 timer
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
    },
  })
);

app.use((req, res, next) => {
  res.locals.appName = config.appName;
  next();
});

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('public/not-found');
});

app.listen(config.port, config.host, () => {
  console.log(`Møteromsbooking kjører på http://${config.host}:${config.port}`);
});

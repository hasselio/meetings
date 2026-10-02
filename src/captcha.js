const crypto = require('crypto');
const { create, CappedMap, randomInt } = require('altcha-lib/frameworks/express');
const { deriveKey } = require('altcha-lib/algorithms/pbkdf2');
const config = require('./config');

// Egne nøkler avledet fra SESSION_SECRET, så det ikke trengs flere hemmeligheter i .env.
const derive = (label) => crypto.createHmac('sha256', config.sessionSecret).update(label).digest('hex');

// Hver variant har egne nøkler, så en løsning på den lette oppgaven ikke godtas der den tunge kreves.
function variant(name, counter) {
  const altcha = create({
    deriveKey,
    hmacSignatureSecret: derive(`altcha-signature${name}`),
    hmacKeySignatureSecret: derive(`altcha-key-signature${name}`),
    // Husker brukte utfordringer, så samme løsning ikke kan sendes inn to ganger.
    store: new CappedMap({ maxSize: 10000 }),
    createChallengeParameters: () => ({
      algorithm: 'PBKDF2/SHA-256',
      cost: 5000,
      counter: randomInt(...counter),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }),
  });
  const middleware = altcha.middleware({ throwOnFailure: false });

  // Resultatet havner i res.locals.altcha.error. Automatiske tester slipper å løse oppgaven.
  function verify(req, res, next) {
    if (config.isTest && req.body && req.body.altcha === 'test-bypass') {
      res.locals.altcha = { error: null };
      return next();
    }
    return middleware(req, res, next);
  }
  return { challengeHandler: altcha.challengeHandler, verify };
}

// Tilgangsforespørsler er sjeldne og verdifulle for en angriper: tung oppgave.
const access = variant('', [5000, 10000]);
// Booking skal gå raskt for folk; e-postbekreftelse og grenser per IP og e-post tar resten.
const booking = variant('-booking', [800, 2000]);

module.exports = {
  challengeHandler: access.challengeHandler,
  verifyCaptcha: access.verify,
  bookingChallengeHandler: booking.challengeHandler,
  verifyBookingCaptcha: booking.verify,
};

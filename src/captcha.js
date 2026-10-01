const crypto = require('crypto');
const { create, CappedMap, randomInt } = require('altcha-lib/frameworks/express');
const { deriveKey } = require('altcha-lib/algorithms/pbkdf2');
const config = require('./config');

// Egne nøkler avledet fra SESSION_SECRET, så det ikke trengs flere hemmeligheter i .env.
const derive = (label) => crypto.createHmac('sha256', config.sessionSecret).update(label).digest('hex');

const altcha = create({
  deriveKey,
  hmacSignatureSecret: derive('altcha-signature'),
  hmacKeySignatureSecret: derive('altcha-key-signature'),
  // Husker brukte utfordringer, så samme løsning ikke kan sendes inn to ganger.
  store: new CappedMap({ maxSize: 10000 }),
  createChallengeParameters: () => ({
    algorithm: 'PBKDF2/SHA-256',
    cost: 5000,
    counter: randomInt(5000, 10000),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  }),
});

module.exports = {
  challengeHandler: altcha.challengeHandler,
  verifyCaptcha: altcha.middleware({ throwOnFailure: false }),
};

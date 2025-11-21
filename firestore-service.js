const admin = require('firebase-admin');
require('dotenv').config();

function init() {
  if (admin.apps.length) return admin.firestore();
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
  try {
    if (saPath) {
      const serviceAccount = require(saPath);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else if (saJson) {
      const serviceAccount = JSON.parse(saJson);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
      admin.initializeApp();
    }
  } catch (_) {
    admin.initializeApp();
  }
  return admin.firestore();
}

const db = init();
module.exports = { db, admin };
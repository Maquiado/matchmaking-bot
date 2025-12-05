const admin = require('firebase-admin');

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID || undefined;
  const credential = admin.credential.applicationDefault();
  admin.initializeApp({ credential, projectId });
}

const db = admin.firestore();

module.exports = {
  admin,
  db,
  FieldValue: admin.firestore.FieldValue,
  Timestamp: admin.firestore.Timestamp
};


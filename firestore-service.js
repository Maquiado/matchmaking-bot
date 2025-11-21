const admin = require('firebase-admin');
require('dotenv').config();

function init() {
  if (admin.apps.length) return admin.firestore();
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
  try {
    if (saPath) {
      const serviceAccount = require(saPath);
      if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      const projectId = serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID;
      if (projectId && !process.env.GOOGLE_CLOUD_PROJECT) process.env.GOOGLE_CLOUD_PROJECT = projectId;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId });
    } else if (saJson) {
      const serviceAccount = JSON.parse(saJson);
      if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      const projectId = serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID;
      if (projectId && !process.env.GOOGLE_CLOUD_PROJECT) process.env.GOOGLE_CLOUD_PROJECT = projectId;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
      admin.initializeApp(projectId ? { projectId } : {});
    }
  } catch (e) {
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    admin.initializeApp(projectId ? { projectId } : {});
  }
  return admin.firestore();
}

const db = init();
module.exports = { db, admin };
/**
 * Enable Cloud Firestore for the project using the Admin SDK service account.
 * Fixes: "Cloud Firestore API has not been used in project <id> before or it is disabled."
 *
 * Usage:
 *   node scripts/enable-firestore.mjs
 *
 * Requires the service account to have permission to enable GCP services
 * (roles/editor or Service Usage Admin). Uses google-auth-library (already
 * a transitive dependency of firebase-admin).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JWT } from 'google-auth-library';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const saPath = path.join(SERVER_ROOT, 'serviceAccountKey.json');

if (!fs.existsSync(saPath)) {
  console.error('Missing server/serviceAccountKey.json');
  process.exit(1);
}

const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
const project = process.env.GCLOUD_PROJECT || sa.project_id;
const service = process.env.SERVICE || 'firestore.googleapis.com';

const client = new JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function getState() {
  const r = await client.request({
    url: `https://serviceusage.googleapis.com/v1/projects/${project}/services/${service}`,
  });
  return r.data;
}

async function enableService() {
  console.log(`Enabling ${service} on project ${project} ...`);
  const r = await client.request({
    url: `https://serviceusage.googleapis.com/v1/projects/${project}/services/${service}:enable`,
    method: 'POST',
  });
  return r.data;
}

async function ensureDefaultDatabase() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases`;
  try {
    const list = await client.request({ url });
    const dbs = list.data.databases || [];
    if (dbs.some((d) => d.name.endsWith('/databases/(default)'))) {
      console.log('Default Firestore database already exists.');
      return;
    }
  } catch (e) {
    console.warn('Could not list databases (may need creation):', e.message);
  }
  console.log('Creating default Firestore database (native mode, us-central1) ...');
  try {
    const r = await client.request({
      url,
      method: 'POST',
      params: { databaseId: '(default)' },
      data: { type: 'FIRESTORE_NATIVE', locationId: 'us-central1' },
    });
    console.log('Database create operation:', JSON.stringify(r.data).slice(0, 300));
  } catch (e) {
    if (/already exists/i.test(e.message)) {
      console.log('Default database already exists.');
    } else {
      throw e;
    }
  }
}

// Wait for the enable operation to propagate (poll state).
async function waitEnabled(attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const st = await getState();
    if (st.state === 'ENABLED') return st;
    if (st.state === 'DISABLED') throw new Error('Service reported DISABLED');
    await new Promise((r) => setTimeout(r, 5000));
  }
  const st = await getState();
  if (st.state !== 'ENABLED') throw new Error(`Service did not become ENABLED (state=${st.state})`);
  return st;
}

try {
  let st = await getState().catch((e) => {
    if (e.code === 404) return { state: 'UNKNOWN' };
    throw e;
  });
  console.log('Current state:', st.state || 'UNKNOWN');

  if (st.state !== 'ENABLED') {
    await enableService();
    st = await waitEnabled();
    console.log(`✅ ${service} is now ${st.state}`);
  } else {
    console.log(`✅ ${service} already ${st.state}`);
  }

  await ensureDefaultDatabase();
  console.log('Firestore setup complete.');
} catch (err) {
  console.error(`❌ Failed: ${err.message}`);
  if (err.response && err.response.data) {
    console.error('  Details:', JSON.stringify(err.response.data).slice(0, 500));
  }
  process.exit(1);
}

'use strict';

/**
 * **payfastInit** = 1st gen `https.onCall`; **payfastItn** = 1st gen `onRequest`.
 * If the browser shows a CORS preflight error from `http://localhost:…`, open Google Cloud Console →
 * Cloud Functions → `payfastInit` → Permissions → ensure **allUsers** has **Cloud Functions Invoker**
 * (callable `OPTIONS` must succeed without a Firebase ID token).
 * Config: `functions.config()` and/or env vars `PAYFAST_*`, `APP_PUBLIC_ORIGIN` (see `.env.example`).
 */

const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');
const functions = require('firebase-functions/v1');

admin.initializeApp();
const db = admin.firestore();

const REGION = 'europe-west1';

const HOURLY_RATE_ZAR = {
  'One-on-One In Person': 400,
  'One-on-One Online': 300,
};
const FLAT_RATE_ZAR = {
  'Explanatory Videos': 150,
  'Personalised Notes': 150,
};

const PAYMENT_READY_STATUSES = new Set(['pending_payment', 'confirmed', 'scheduled']);

function timeStringToMinutes(time24) {
  if (!time24) return null;
  const [hh, mm] = String(time24).split(':');
  const h = parseInt(hh, 10);
  const m = parseInt(mm, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function sessionDurationHours(session) {
  if (!session) return 0;
  if (session.startTime && session.endTime && session.preferredDate) {
    const startMin = timeStringToMinutes(session.startTime);
    const endMin = timeStringToMinutes(session.endTime);
    if (startMin == null || endMin == null) return 0;
    const diff = endMin - startMin;
    return diff > 0 ? diff / 60 : 0;
  }
  if (session.lessonStartDate && session.lessonEndDate) {
    const a = new Date(session.lessonStartDate).getTime();
    const b = new Date(session.lessonEndDate).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    const diffMs = b - a;
    return diffMs > 0 ? diffMs / (1000 * 60 * 60) : 0;
  }
  return 0;
}

function computeSessionAmountZar(session) {
  if (session == null) return null;
  const custom = session.paymentAmountZar;
  if (custom != null && custom !== '') {
    const n = Number(custom);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
  }
  const service = session.serviceType || '';
  const flat = FLAT_RATE_ZAR[service];
  if (flat != null) return flat;
  const hourly = HOURLY_RATE_ZAR[service];
  if (hourly != null) {
    const h = sessionDurationHours(session);
    if (h > 0) return Math.round(hourly * h * 100) / 100;
  }
  return null;
}

function formatPayfastAmount(zar) {
  return Number(zar).toFixed(2);
}

function moneyMatches(received, expected) {
  const a = Math.round(parseFloat(String(received)) * 100);
  const b = Math.round(parseFloat(String(expected)) * 100);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function payfastSignatureString(data, passphrase) {
  const filtered = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'signature') continue;
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s === '') continue;
    filtered[k] = s;
  }
  const keys = Object.keys(filtered).sort();
  let out = '';
  for (const key of keys) {
    const enc = encodeURIComponent(filtered[key]).replace(/%20/g, '+');
    out += (out ? '&' : '') + key + '=' + enc;
  }
  const pass = passphrase != null ? String(passphrase).trim() : '';
  if (pass !== '') {
    out += '&passphrase=' + encodeURIComponent(pass).replace(/%20/g, '+');
  }
  return out;
}

function payfastSignature(data, passphrase) {
  return crypto.createHash('md5').update(payfastSignatureString(data, passphrase)).digest('hex');
}

function getPayfastConfig() {
  const envId = (process.env.PAYFAST_MERCHANT_ID || '').trim();
  const envKey = (process.env.PAYFAST_MERCHANT_KEY || '').trim();
  const envOrigin = String(process.env.APP_PUBLIC_ORIGIN || '')
    .trim()
    .replace(/\/$/, '');
  if (envId && envKey && envOrigin) {
    const passphrase = process.env.PAYFAST_PASSPHRASE != null ? String(process.env.PAYFAST_PASSPHRASE) : '';
    const sandbox = String(process.env.PAYFAST_SANDBOX || 'true').toLowerCase() === 'true';
    const processUrl = sandbox
      ? 'https://sandbox.payfast.co.za/eng/process'
      : 'https://www.payfast.co.za/eng/process';
    return {
      merchantId: envId,
      merchantKey: envKey,
      passphrase,
      sandbox,
      processUrl,
      publicOrigin: envOrigin,
    };
  }
  const pf = functions.config().payfast || {};
  const app = functions.config().app || {};
  const merchantId = pf.merchant_id;
  const merchantKey = pf.merchant_key;
  const passphrase = pf.passphrase != null ? String(pf.passphrase) : '';
  const sandbox = String(pf.sandbox || 'true').toLowerCase() === 'true';
  const publicOrigin = (app.public_origin || '').replace(/\/$/, '');
  if (!merchantId || !merchantKey) {
    throw new Error('Missing payfast.merchant_id / payfast.merchant_key. Run firebase functions:config:set.');
  }
  if (!publicOrigin) {
    throw new Error('Missing app.public_origin in functions config.');
  }
  const processUrl = sandbox
    ? 'https://sandbox.payfast.co.za/eng/process'
    : 'https://www.payfast.co.za/eng/process';
  return {
    merchantId: String(merchantId).trim(),
    merchantKey: String(merchantKey).trim(),
    passphrase,
    sandbox,
    processUrl,
    publicOrigin,
  };
}

function splitDisplayName(name) {
  const n = (name || '').trim();
  if (!n) return { first: 'Student', last: '-' };
  const parts = n.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '-' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

exports.payfastInit = functions.region(REGION).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in to pay.');
  }
  const sessionId = (data && data.sessionId) || '';
  if (!sessionId || typeof sessionId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'sessionId required.');
  }

  let config;
  try {
    config = getPayfastConfig();
  } catch (e) {
    console.error(e);
    throw new functions.https.HttpsError('failed-precondition', 'Payment gateway is not configured yet.');
  }

  const sessionRef = db.collection('sessions').doc(sessionId);
  const snap = await sessionRef.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Booking not found.');
  }
  const session = snap.data();
  if (session.studentId !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'This booking is not yours.');
  }
  if (session.paid === true) {
    throw new functions.https.HttpsError('failed-precondition', 'Already paid.');
  }
  if (!PAYMENT_READY_STATUSES.has(session.status || '')) {
    throw new functions.https.HttpsError('failed-precondition', 'This booking is not ready for payment.');
  }
  if (!session.tutorId) {
    throw new functions.https.HttpsError('failed-precondition', 'No tutor assigned yet.');
  }

  const amountNum = computeSessionAmountZar(session);
  if (amountNum == null || amountNum <= 0) {
    throw new functions.https.HttpsError('failed-precondition', 'Could not compute amount for this booking.');
  }
  const amount = formatPayfastAmount(amountNum);
  const { first: nameFirst, last: nameLast } = splitDisplayName(session.studentName);
  const email = (session.studentEmail || context.auth.token.email || '').trim();
  if (!email) {
    throw new functions.https.HttpsError('failed-precondition', 'Student email is required for PayFast.');
  }

  const projectId =
    process.env.GCLOUD_PROJECT || (admin.app().options && admin.app().options.projectId) || 'studim8tutoring-bba8e';
  const returnUrl = `${config.publicOrigin}/student.html?payfast=return`;
  const cancelUrl = `${config.publicOrigin}/student.html?payfast=cancel`;
  const notifyUrl = `https://${REGION}-${projectId}.cloudfunctions.net/payfastItn`;

  const itemName = `StudiM8: ${String(session.subject || 'lesson').slice(0, 90)}`;

  const pfData = {
    merchant_id: config.merchantId,
    merchant_key: config.merchantKey,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    notify_url: notifyUrl,
    name_first: nameFirst.slice(0, 100),
    name_last: nameLast.slice(0, 100),
    email_address: email.slice(0, 255),
    m_payment_id: sessionId,
    amount,
    item_name: itemName,
    custom_str1: sessionId,
  };

  const signature = payfastSignature(pfData, config.passphrase);
  const fields = { ...pfData, signature };

  return {
    actionUrl: config.processUrl,
    fields,
    amount,
    itemName,
  };
});

const payfastItnApp = express();
payfastItnApp.use(express.urlencoded({ extended: false }));

payfastItnApp.post('/', async (req, res) => {
  const body = req.body || {};
  try {
    let config;
    try {
      config = getPayfastConfig();
    } catch (e) {
      console.error('PayFast config error', e);
      return res.status(200).send('');
    }

    const receivedSig = (body.signature || '').trim().toLowerCase();
    const computed = payfastSignature(body, config.passphrase).toLowerCase();
    if (!receivedSig || receivedSig !== computed) {
      console.warn('PayFast ITN invalid signature');
      return res.status(200).send('');
    }

    if (String(body.merchant_id) !== String(config.merchantId)) {
      console.warn('PayFast ITN merchant mismatch');
      return res.status(200).send('');
    }

    const paymentStatus = (body.payment_status || '').trim().toUpperCase();
    if (paymentStatus !== 'COMPLETE') {
      return res.status(200).send('OK');
    }

    const sessionId = (body.m_payment_id || body.custom_str1 || '').trim();
    if (!sessionId) {
      return res.status(200).send('');
    }

    const amountExpected = body.amount_gross != null ? body.amount_gross : body.amount;
    const pfPaymentId = (body.pf_payment_id || '').trim();

    await db.runTransaction(async (t) => {
      const ref = db.collection('sessions').doc(sessionId);
      const snap = await t.get(ref);
      if (!snap.exists) return;
      const s = snap.data();
      if (s.paid === true) return;

      const expectedZar = computeSessionAmountZar(s);
      if (expectedZar == null || !moneyMatches(amountExpected, formatPayfastAmount(expectedZar))) {
        console.warn('PayFast ITN amount mismatch', sessionId, amountExpected, expectedZar);
        return;
      }

      t.update(ref, {
        paid: true,
        paidAt: new Date().toISOString(),
        paymentMethod: 'payfast',
        payfastPaymentId: pfPaymentId || null,
        payfastAmountGross: amountExpected != null ? String(amountExpected) : null,
        payfastItnAt: new Date().toISOString(),
      });
    });

    return res.status(200).send('OK');
  } catch (e) {
    console.error('payfastItn', e);
    return res.status(500).send('');
  }
});

exports.payfastItn = functions.region(REGION).https.onRequest(payfastItnApp);

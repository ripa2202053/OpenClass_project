import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, getDocs, writeBatch
} from 'firebase/firestore';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { getAuth } from 'firebase/auth';

// ─── CRUD ──────────────────────────────────────────────────────

export async function createNotification(recipientId, type, title, body, data = {}) {
  const db = getFirestore();
  await addDoc(collection(db, 'notifications'), {
    recipientId,
    userId: recipientId,
    type,
    title,
    message: body,
    body,
    data,
    isRead: false,
    read: false,
    createdAt: serverTimestamp(),
  });
}

export async function createBulkNotifications(recipientIds, type, title, body, data = {}) {
  const db = getFirestore();
  const batch = writeBatch(db);
  const colRef = collection(db, 'notifications');
  recipientIds.forEach(uid => {
    const ref = doc(colRef);
    batch.set(ref, {
      recipientId: uid, userId: uid, type, title, message: body, body, data,
      isRead: false, read: false, createdAt: serverTimestamp(),
    });
  });
  await batch.commit();
}

import { safeOnSnapshot, isQuotaExceededError } from './utils/firestoreGuard.js';

// ─── Per-user notifications sub-collection ─────────────────────────────
// Teacher actions fan out to each enrolled student's own
// `users/{studentId}/notifications` sub-collection. Students only read their
// own sub-collection (rules enforce ownership), giving full data isolation.

const subNotifTime = (n) => {
  const t = n.timestamp || n.createdAt;
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.toDate === 'function') return t.toDate().getTime();
  const ms = Date.parse(t);
  return isNaN(ms) ? 0 : ms;
};

export function subscribeUserNotifications(uid, callback) {
  const db = getFirestore();
  const unsubs = [];
  const seen = new Map();

  const deliver = () => {
    const list = [...seen.values()].sort((a, b) => subNotifTime(b) - subNotifTime(a));
    callback(list);
  };

  unsubs.push(safeOnSnapshot(
    query(collection(db, 'users', uid, 'notifications'), orderBy('timestamp', 'desc'), limit(100)),
    (snap) => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'removed') seen.delete(ch.doc.id);
        else seen.set(ch.doc.id, { id: ch.doc.id, _source: 'sub', ...ch.doc.data() });
      });
      deliver();
    },
    (err) => {
      // orderBy('timestamp') drops docs lacking a timestamp; fall back to an
      // unordered snapshot so no notification is ever hidden.
      console.warn('[notificationService] subscribeUserNotifications ordered query failed, falling back:', err);
      const unsub = safeOnSnapshot(
        collection(db, 'users', uid, 'notifications'),
        (snap) => {
          snap.docs.forEach(d => seen.set(d.id, { id: d.id, _source: 'sub', ...d.data() }));
          deliver();
        },
        () => {},
        'subscribeUserNotifications.unordered'
      );
      unsubs.push(unsub);
    },
    'subscribeUserNotifications'
  ));

  return () => unsubs.forEach(u => u());
}

export async function markUserNotificationRead(uid, notificationId) {
  if (!uid || !notificationId) return;
  await updateDoc(doc(getFirestore(), 'users', uid, 'notifications', notificationId), { read: true, isRead: true });
}

export async function markAllUserNotificationsRead(uid) {
  if (!uid) return;
  const db = getFirestore();
  try {
    const snap = await getDocs(query(collection(db, 'users', uid, 'notifications'), where('read', '==', false)));
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.update(d.ref, { read: true, isRead: true }));
    await batch.commit();
  } catch (e) {
    if (isQuotaExceededError(e)) console.warn('[notificationService] markAllUserNotificationsRead quota warning:', e.message);
    else throw e;
  }
}

export async function deleteUserNotification(uid, notificationId) {
  if (!uid || !notificationId) return;
  await deleteDoc(doc(getFirestore(), 'users', uid, 'notifications', notificationId));
}

export function subscribeNotifications(uid, callback) {
  const db = getFirestore();
  const seen = new Map();
  const unsubs = [];
  const attach = (field) => {
    unsubs.push(safeOnSnapshot(
      query(collection(db, 'notifications'), where(field, '==', uid)),
      (snap) => {
        snap.docChanges().forEach(ch => {
          const d = ch.doc;
          if (ch.type === 'removed') seen.delete(d.id);
          else seen.set(d.id, { id: d.id, ...d.data() });
        });
        const mine = [...seen.values()].filter(n =>
          n.recipientId === uid || n.userId === uid || n.teacherUid === uid
        );
        callback(mine);
      },
      (err) => console.warn(`[notificationService] subscribeNotifications quota warning for field ${field}:`, err),
      `subscribeNotifications_${field}`
    ));
  };
  attach('recipientId');
  attach('userId');
  return () => unsubs.forEach(u => u());
}

export async function markAsRead(notificationId) {
  await updateDoc(doc(getFirestore(), 'notifications', notificationId), { read: true, isRead: true });
}

export async function markAllAsRead(uid) {
  const db = getFirestore();
  // Query both recipientId and userId (legacy schema) so every unread doc is
  // cleared regardless of which field addresses this user. Read filtering is
  // done client-side to avoid requiring composite indexes.
  const [snapA, snapB] = await Promise.all([
    getDocs(query(collection(db, 'notifications'), where('recipientId', '==', uid))),
    getDocs(query(collection(db, 'notifications'), where('userId', '==', uid))),
  ]);
  const batch = writeBatch(db);
  const seen = new Set();
  [...snapA.docs, ...snapB.docs].forEach(d => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    const data = d.data();
    const isRead = data.isRead === undefined ? !!data.read : !!data.isRead;
    if (isRead) return;
    batch.update(d.ref, { read: true, isRead: true });
  });
  await batch.commit();
}

export async function deleteNotification(notificationId) {
  await deleteDoc(doc(getFirestore(), 'notifications', notificationId));
}

// ─── FCM ───────────────────────────────────────────────────────

export async function setupFCM(uid) {
  // FCM getToken() 401s on localhost (no valid push key) and just pollutes the
  // console — skip Push token registration entirely on local dev environments.
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    console.log('[FCM] Skipping Push Token registration on localhost environment.');
    return null;
  }
  // Permission permanently blocked → exit gracefully without any token attempt.
  if (typeof Notification !== 'undefined' && Notification.permission === 'blocked') {
    return null;
  }
  try {
    // Register the Firebase Messaging service worker first so getToken() has a
    // working registration for background push messages.
    let registration = null;
    if ('serviceWorker' in navigator) {
      try {
        registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      } catch (swErr) {
        console.warn('FCM service worker registration failed:', swErr);
      }
    }
    const messaging = getMessaging();
    const tokenOptions = { vapidKey: 'BGrpDmnMH3_NFyQbX9BJU1d4XGNGSNQFQ9KJBHUHpuUGGPFzxZqgNjOXE6ELEls1wnKWMfsd1_MqK2W_6t6xRPs' };
    if (registration) tokenOptions.serviceWorkerRegistration = registration;
    const token = await getToken(messaging, tokenOptions);
    if (token) {
      const db = getFirestore();
      await setDoc(doc(db, 'fcmTokens', token), { uid, createdAt: serverTimestamp() });
    }
    return token;
  } catch (e) {
    const code = (e && (e.code || e.message || e.name || '')) || '';
    // AbortError / permission-declined / service-worker failures are expected on
    // localhost & strict browsers — swallow them silently (best-effort, non
    // blocking) so no uncaught rejection breaks app initialization.
    if (/abort|permission-blocked|permission_denied|permission_default|serviceworker|messaging\/(permission|token|service-worker)/i.test(code)) {
      return null;
    }
    console.warn('FCM setup failed:', e);
    return null;
  }
}

export function onForegroundMessage(callback) {
  try {
    onMessage(getMessaging(), (payload) => {
      callback(payload);
    });
  } catch (e) { /* no messaging available */ }
}

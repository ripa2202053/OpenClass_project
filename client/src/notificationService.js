import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, onSnapshot, serverTimestamp, getDocs, writeBatch
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

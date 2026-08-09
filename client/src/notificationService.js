import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, serverTimestamp, getDocs, writeBatch
} from 'firebase/firestore';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { getAuth } from 'firebase/auth';

// ─── CRUD ──────────────────────────────────────────────────────

export async function createNotification(recipientId, type, title, body, data = {}) {
  const db = getFirestore();
  await addDoc(collection(db, 'notifications'), {
    recipientId,
    type,
    title,
    body,
    data,
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
      recipientId: uid, type, title, body, data,
      read: false, createdAt: serverTimestamp(),
    });
  });
  await batch.commit();
}

export function subscribeNotifications(uid, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(
      collection(db, 'notifications'),
      where('recipientId', '==', uid),
      orderBy('createdAt', 'desc')
    ),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export async function markAsRead(notificationId) {
  await updateDoc(doc(getFirestore(), 'notifications', notificationId), { read: true });
}

export async function markAllAsRead(uid) {
  const db = getFirestore();
  const snap = await getDocs(query(
    collection(db, 'notifications'),
    where('recipientId', '==', uid),
    where('read', '==', false)
  ));
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { read: true }));
  await batch.commit();
}

export async function deleteNotification(notificationId) {
  await deleteDoc(doc(getFirestore(), 'notifications', notificationId));
}

// ─── FCM ───────────────────────────────────────────────────────

export async function setupFCM(uid) {
  // Permission permanently blocked → exit gracefully without any token attempt.
  if (typeof Notification !== 'undefined' && Notification.permission === 'blocked') {
    return null;
  }
  try {
    const messaging = getMessaging();
    const token = await getToken(messaging, { vapidKey: 'BGrpDmnMH3_NFyQbX9BJU1d4XGNGSNQFQ9KJBHUHpuUGGPFzxZqgNjOXE6ELEls1wnKWMfsd1_MqK2W_6t6xRPs' });
    if (token) {
      const db = getFirestore();
      await setDoc(doc(db, 'fcmTokens', token), { uid, createdAt: serverTimestamp() });
    }
    return token;
  } catch (e) {
    const code = (e && (e.code || e.message || '')) || '';
    // Permission-declined/blocked errors are expected on localhost & strict browsers —
    // swallow them silently so no uncaught promise rejection is logged.
    if (/permission-blocked|permission_denied|permission_default|messaging\/(permission|token)/i.test(code)) {
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

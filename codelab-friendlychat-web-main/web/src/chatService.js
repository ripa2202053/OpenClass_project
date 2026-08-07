import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  setDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  limit,
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL,
} from 'firebase/storage';

const LOADING_IMAGE_URL = 'https://www.google.com/images/spin-32.gif?a';

// ─── Channels ──────────────────────────────────────────────────────────────

export function subscribeToChannels(callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'channels'), where('isActive', '==', true), orderBy('createdAt', 'asc')),
    (snap) => {
      const channels = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(channels);
    }
  );
}

export async function createChannel(name, user) {
  if (!name || !name.trim()) throw new Error('Channel name is required.');
  const db = getFirestore();
  await addDoc(collection(db, 'channels'), {
    name: name.trim(),
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    isActive: true,
  });
}

// ─── Messages ──────────────────────────────────────────────────────────────

export async function sendMessage(channelId, text, user) {
  if (!text || !text.trim()) return;
  const db = getFirestore();
  await addDoc(collection(db, 'channels', channelId, 'messages'), {
    text: text.trim(),
    senderId: user.uid,
    senderName: user.displayName || 'Unknown',
    senderPic: user.photoURL || '',
    timestamp: serverTimestamp(),
    editedAt: null,
  });
}

export async function sendImageMessage(channelId, file, user) {
  const db = getFirestore();
  const msgRef = await addDoc(collection(db, 'channels', channelId, 'messages'), {
    text: '',
    imageUrl: LOADING_IMAGE_URL,
    senderId: user.uid,
    senderName: user.displayName || 'Unknown',
    senderPic: user.photoURL || '',
    timestamp: serverTimestamp(),
    editedAt: null,
  });

  const filePath = `chat/${channelId}/${msgRef.id}/${file.name}`;
  const storageRef = ref(getStorage(), filePath);
  const snap = await uploadBytesResumable(storageRef, file);
  const downloadUrl = await getDownloadURL(storageRef);

  await updateDoc(msgRef, {
    imageUrl: downloadUrl,
    storageUri: snap.metadata.fullPath,
  });
}

export function subscribeToMessages(channelId, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(
      collection(db, 'channels', channelId, 'messages'),
      orderBy('timestamp', 'asc'),
      limit(100)
    ),
    (snap) => {
      const msgs = [];
      snap.docChanges().forEach(change => {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          const idx = msgs.findIndex(m => m.id === change.doc.id);
          const entry = { id: change.doc.id, ...data };
          if (idx >= 0) msgs[idx] = entry;
          else msgs.push(entry);
        } else if (change.type === 'removed') {
          const idx = msgs.findIndex(m => m.id === change.doc.id);
          if (idx >= 0) msgs.splice(idx, 1);
        }
      });
      msgs.sort((a, b) => {
        const ta = a.timestamp ? a.timestamp.toMillis() : 0;
        const tb = b.timestamp ? b.timestamp.toMillis() : 0;
        return ta - tb;
      });
      callback(msgs);
    }
  );
}

// ─── Typing Indicator ──────────────────────────────────────────────────────

export function setTyping(channelId, uid, displayName, isTyping) {
  const db = getFirestore();
  const ref = doc(db, 'channels', channelId, 'typing', uid);
  if (isTyping) {
    setDoc(ref, { displayName, timestamp: serverTimestamp() }, { merge: true });
  } else {
    deleteDoc(ref).catch(() => {});
  }
}

export function subscribeToTyping(channelId, uid, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'channels', channelId, 'typing')),
    (snap) => {
      const typing = [];
      snap.docs.forEach(d => {
        if (d.id !== uid) {
          typing.push({ uid: d.id, ...d.data() });
        }
      });
      callback(typing);
    }
  );
}

// ─── Seen / Read Status ────────────────────────────────────────────────────

export function markChannelAsRead(channelId, uid) {
  const db = getFirestore();
  const ref = doc(db, 'channels', channelId, 'readBy', uid);
  setDoc(ref, { lastReadAt: serverTimestamp() }, { merge: true });
}

export function subscribeToUnreadCounts(uid, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'channels'), where('isActive', '==', true)),
    async (snap) => {
      const channels = snap.docs.map(d => d.id);
      const unreadMap = {};
      for (const cId of channels) {
        const readRef = doc(db, 'channels', cId, 'readBy', uid);
        const readSnap = await getDoc(readRef);
        const lastRead = readSnap.exists() ? (readSnap.data().lastReadAt || 0) : 0;
        const msgsSnap = await getDocs(
          query(collection(db, 'channels', cId, 'messages'), orderBy('timestamp', 'desc'), limit(1))
        );
        let unread = 0;
        if (!msgsSnap.empty) {
          const lastMsg = msgsSnap.docs[0].data();
          const lastMsgTime = lastMsg.timestamp ? lastMsg.timestamp.toMillis() : 0;
          const lastReadTime = lastRead ? (lastRead.toMillis ? lastRead.toMillis() : 0) : 0;
          if (lastMsg.senderId !== uid && lastMsgTime > lastReadTime) {
            unread = 1;
          }
        }
        unreadMap[cId] = unread;
      }
      callback(unreadMap);
    }
  );
}

export function subscribeToSeenStatus(channelId, messageId, callback) {
  const db = getFirestore();
  return onSnapshot(
    collection(db, 'channels', channelId, 'messages', messageId, 'seenBy'),
    (snap) => {
      const seenBy = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      callback(seenBy);
    }
  );
}

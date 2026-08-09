import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs,
  updateDoc, deleteDoc, setDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp,
  arrayUnion, arrayRemove, increment
} from 'firebase/firestore';
import {
  getStorage, ref, uploadBytesResumable, getDownloadURL
} from 'firebase/storage';
import { getDatabase, ref as dbRef, onValue, set, onDisconnect, serverTimestamp as rtdbTimestamp, off } from 'firebase/database';

export async function sendFileMessage(channelId, file, sender, text) {
  const db = getFirestore();
  const storage = getStorage();
  const ext = file.name.split('.').pop() || 'bin';
  const path = `chat_files/${channelId}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  const snap = await uploadBytesResumable(storageRef, file);
  const url = await getDownloadURL(snap.ref);
  await addDoc(collection(db, 'channels', channelId, 'messages'), {
    text: text || '',
    senderId: sender.uid,
    senderName: sender.displayName || 'Unknown',
    senderPhoto: sender.photoURL || '',
    type: 'file',
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || ext,
    fileUrl: url,
    timestamp: serverTimestamp(),
    reactions: [],
    replyTo: null,
    editedAt: null,
    deletedAt: null,
  });
}

export function subscribeMessages(channelId, callback, msgLimit = 100) {
  return onSnapshot(
    query(
      collection(getFirestore(), 'channels', channelId, 'messages'),
      orderBy('timestamp', 'desc'),
      limit(msgLimit)
    ),
    (snap) => {
      const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
      callback(msgs);
    }
  );
}

export async function sendMessage(channelId, msg, user) {
  await addDoc(collection(getFirestore(), 'channels', channelId, 'messages'), {
    text: msg,
    senderId: user.uid,
    senderName: user.displayName || 'Unknown',
    senderPhoto: user.photoURL || '',
    type: 'text',
    timestamp: serverTimestamp(),
    reactions: [],
    replyTo: null,
    editedAt: null,
    deletedAt: null,
  });
  await updateDoc(doc(getFirestore(), 'channels', channelId), {
    lastMessage: { text: msg, senderName: user.displayName || 'Unknown', timestamp: serverTimestamp() }
  });
}

export async function sendMessageWithReply(channelId, msg, user, replyTo) {
  await addDoc(collection(getFirestore(), 'channels', channelId, 'messages'), {
    text: msg,
    senderId: user.uid,
    senderName: user.displayName || 'Unknown',
    senderPhoto: user.photoURL || '',
    type: 'text',
    timestamp: serverTimestamp(),
    reactions: [],
    replyTo: { id: replyTo.id, text: replyTo.text, senderName: replyTo.senderName },
    editedAt: null,
    deletedAt: null,
  });
  await updateDoc(doc(getFirestore(), 'channels', channelId), {
    lastMessage: { text: msg, senderName: user.displayName || 'Unknown', timestamp: serverTimestamp() }
  });
}

export function subscribeChannels(callback) {
  return onSnapshot(
    query(collection(getFirestore(), 'channels'), orderBy('lastMessage', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export async function createChannel(name, createdBy) {
  const ref = await addDoc(collection(getFirestore(), 'channels'), {
    name, createdBy, createdAt: serverTimestamp(),
    lastMessage: null, memberCount: 0,
  });
  return { id: ref.id };
}

export function setTyping(channelId, userId, userName, isTyping) {
  const db = getFirestore();
  const ref = doc(db, 'channels', channelId, 'typing', userId);
  if (isTyping) {
    setDoc(ref, { userName, timestamp: serverTimestamp() });
  } else {
    deleteDoc(ref).catch(() => {});
  }
}

export function subscribeTyping(channelId, callback = () => {}) {
  return onSnapshot(
    query(collection(getFirestore(), 'channels', channelId, 'typing')),
    (snap) => {
      const typing = snap.docs.map(d => d.data().userName).filter(Boolean);
      if (typeof callback === 'function') callback(typing);
    }
  );
}

export function subscribeReadReceipts(channelId, callback = () => {}) {
  return onSnapshot(
    query(collection(getFirestore(), 'channels', channelId, 'readReceipts')),
    (snap) => {
      const receipts = {};
      snap.docs.forEach(d => {
        const data = d.data();
        receipts[d.id] = { ...data, id: d.id };
      });
      if (typeof callback === 'function') callback(receipts);
    }
  );
}

export async function markRead(channelId, userId, lastMsgId) {
  if (!channelId || !userId) return;
  const db = getFirestore();
  await setDoc(doc(db, 'channels', channelId, 'readReceipts', userId), {
    lastReadMsgId: lastMsgId || '', timestamp: serverTimestamp(),
  });
}

export async function addReaction(channelId, messageId, userId, emoji) {
  const db = getFirestore();
  const msgRef = doc(db, 'channels', channelId, 'messages', messageId);
  await updateDoc(msgRef, {
    reactions: arrayUnion({ userId, emoji, timestamp: Date.now() })
  });
}

export async function removeReaction(channelId, messageId, userId, emoji) {
  const db = getFirestore();
  const msgRef = doc(db, 'channels', channelId, 'messages', messageId);
  const msgSnap = await getDoc(msgRef);
  if (!msgSnap.exists()) return;
  const msg = msgSnap.data();
  const filtered = (msg.reactions || []).filter(r => !(r.userId === userId && r.emoji === emoji));
  await updateDoc(msgRef, { reactions: filtered });
}

export async function editMessage(channelId, messageId, newText) {
  await updateDoc(doc(getFirestore(), 'channels', channelId, 'messages', messageId), {
    text: newText, editedAt: serverTimestamp(),
  });
}

export async function deleteMessage(channelId, messageId) {
  await updateDoc(doc(getFirestore(), 'channels', channelId, 'messages', messageId), {
    text: '[deleted]', deletedAt: serverTimestamp(),
  });
}

export function searchMessages(channelId, searchText, callback) {
  return onSnapshot(
    query(
      collection(getFirestore(), 'channels', channelId, 'messages'),
      orderBy('timestamp', 'desc'),
      limit(200)
    ),
    (snap) => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const q = searchText.toLowerCase();
      const filtered = all.filter(m =>
        (m.text && m.text.toLowerCase().includes(q)) ||
        (m.fileName && m.fileName.toLowerCase().includes(q)) ||
        (m.senderName && m.senderName.toLowerCase().includes(q))
      );
      callback(filtered.reverse());
    }
  );
}

export async function createPrivateChat(userIds, classroomId = 'global') {
  const db = getFirestore();
  const validIds = userIds.filter(id => Boolean(id) && typeof id === 'string');
  if (validIds.length === 0) return { id: 'default_chat' };
  if (validIds.length === 1) validIds.push(validIds[0]);

  const sortedIds = [...validIds].sort();
  const chatId = `chat_${sortedIds[0]}_${sortedIds[1]}`;
  const docRef = doc(db, 'privateChats', chatId);

  try {
    const existing = await getDoc(docRef);
    if (!existing.exists()) {
      await setDoc(docRef, {
        userIds: sortedIds,
        classroomId: classroomId || 'global',
        createdAt: serverTimestamp(),
        lastMessage: null,
      });
    }
  } catch (err) {
    console.warn('createPrivateChat setDoc error:', err);
  }
  return { id: chatId };
}

export function subscribePrivateChats(userId, classroomId, callback) {
  return onSnapshot(
    query(
      collection(getFirestore(), 'privateChats'),
      where('userIds', 'array-contains', userId)
    ),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export async function sendPrivateFileMessage(chatId, file, sender, text = '') {
  const db = getFirestore();
  const storage = getStorage();
  const path = `private_chat_files/${chatId}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  let fileUrl = '';
  try {
    const snap = await uploadBytesResumable(storageRef, file);
    fileUrl = await getDownloadURL(snap.ref);
  } catch (err) {
    console.warn('Firebase Storage upload warning, using data URL fallback:', err);
    fileUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
  }

  const senderId = sender?.uid || 'anonymous';
  const senderName = sender?.displayName || sender?.name || 'User';
  const senderPhoto = sender?.photoURL || sender?.photo || '';

  await addDoc(collection(db, 'privateChats', chatId, 'messages'), {
    text: text || '',
    senderId,
    senderName,
    senderPhoto,
    type: 'file',
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'image',
    fileUrl,
    timestamp: serverTimestamp(),
  });

  try {
    await setDoc(doc(db, 'privateChats', chatId), {
      lastMessage: {
        text: '📷 Image attachment',
        senderName,
        senderPhoto,
        senderId,
        timestamp: serverTimestamp()
      }
    }, { merge: true });
  } catch (err) {}
}

export async function sendPrivateMessage(chatId, sender, text) {
  const db = getFirestore();
  const msgRef = collection(db, 'privateChats', chatId, 'messages');
  const senderId = sender?.uid || 'anonymous';
  const senderName = sender?.displayName || sender?.name || 'User';
  const senderPhoto = sender?.photoURL || sender?.photo || '';

  await addDoc(msgRef, {
    text,
    senderId,
    senderName,
    senderPhoto,
    timestamp: serverTimestamp(),
    type: 'text',
  });

  try {
    await setDoc(doc(db, 'privateChats', chatId), {
      lastMessage: {
        text,
        senderName,
        senderPhoto,
        senderId,
        timestamp: serverTimestamp()
      }
    }, { merge: true });
  } catch (err) {
    console.warn('lastMessage update error:', err);
  }
}

export function subscribePrivateMessages(chatId, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'privateChats', chatId, 'messages'), orderBy('timestamp', 'asc')),
    (snap) => {
      const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(msgs);
    },
    async (err) => {
      console.warn('subscribePrivateMessages error, falling back to unordered getDocs:', err);
      try {
        const snap = await getDocs(collection(db, 'privateChats', chatId, 'messages'));
        const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        msgs.sort((a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));
        callback(msgs);
      } catch(e) {
        console.error('Fallback getDocs messages failed:', e);
      }
    }
  );
}

export async function toggleMessageReaction(chatId, messageId, emoji, userId) {
  const db = getFirestore();
  const msgRef = doc(db, 'privateChats', chatId, 'messages', messageId);
  try {
    const snap = await getDoc(msgRef);
    if (snap.exists()) {
      const data = snap.data();
      const reactions = data.reactions || {};
      const currentUsers = reactions[emoji] || [];
      let updatedUsers;
      if (currentUsers.includes(userId)) {
        updatedUsers = currentUsers.filter(u => u !== userId);
      } else {
        updatedUsers = [...currentUsers, userId];
      }
      if (updatedUsers.length === 0) {
        delete reactions[emoji];
      } else {
        reactions[emoji] = updatedUsers;
      }
      await updateDoc(msgRef, { reactions });
    }
  } catch (err) {
    console.warn('toggleMessageReaction error:', err);
  }
}

export function subscribeAllUserPrivateChats(userId, callback) {
  return onSnapshot(
    query(
      collection(getFirestore(), 'privateChats'),
      where('userIds', 'array-contains', userId)
    ),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export function subscribePresence(userId, callback) {
  const rtdb = getDatabase();
  const statusRef = dbRef(rtdb, 'status/' + userId);
  onValue(statusRef, (snap) => {
    const val = snap.val();
    callback(val || { state: 'offline', lastSeen: null });
  });
  return () => off(statusRef);
}

export function setOnline(userId) {
  const rtdb = getDatabase();
  const statusRef = dbRef(rtdb, 'status/' + userId);
  const connectedRef = dbRef(rtdb, '.info/connected');
  onValue(connectedRef, (snap) => {
    if (snap.val() === true) {
      set(statusRef, { state: 'online', lastChanged: Date.now() });
      onDisconnect(statusRef).set({ state: 'offline', lastSeen: Date.now() });
    }
  });
}

export function getOnlineStatus(userId) {
  return new Promise((resolve) => {
    const rtdb = getDatabase();
    const statusRef = dbRef(rtdb, 'status/' + userId);
    onValue(statusRef, (snap) => {
      const val = snap.val();
      resolve(val || { state: 'offline', lastSeen: null });
    }, { onlyOnce: true });
  });
}

// ─── BACKWARD COMPATIBILITY ALIASES ──────────────────────────────
export const subscribeToChannels = subscribeChannels;
export const subscribeToMessages = subscribeMessages;
export const sendImageMessage = sendFileMessage;
export async function markChannelAsRead(channelId, userId) {
  try { await markRead(channelId, userId, '__read__'); } catch {}
}
export function subscribeToUnreadCounts(userId, callback) {
  callback(0);
  return () => {};
}
export function subscribeToTyping(channelId, _userId, callback) {
  return subscribeTyping(channelId, (names) => {
    callback(names.map(n => ({ displayName: n })));
  });
}
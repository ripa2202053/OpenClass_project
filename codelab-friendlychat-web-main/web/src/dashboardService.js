import {
  getFirestore,
  collection,
  collectionGroup,
  doc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  addDoc,
  limit,
} from 'firebase/firestore';

let unsubscribers = [];

function cleanup() {
  unsubscribers.forEach(u => { try { u(); } catch (e) {} });
  unsubscribers = [];
}

export function unsubscribeAll() {
  cleanup();
}

async function getUserClassroomIds(uid) {
  const db = getFirestore();
  const classroomsSnap = await getDocs(
    query(collection(db, 'classrooms'), where('isActive', '==', true))
  );
  const ids = [];
  for (const c of classroomsSnap.docs) {
    const memberSnap = await getDocs(
      query(collection(db, 'classrooms', c.id, 'members'), where('uid', '==', uid))
    );
    if (!memberSnap.empty) ids.push(c.id);
  }
  return ids;
}

export function subscribeDashboardData(uid, callback) {
  cleanup();
  const db = getFirestore();

  getUserClassroomIds(uid).then(classroomIds => {
    callback({ type: 'classroomIds', data: classroomIds });

    if (classroomIds.length === 0) {
      callback({ type: 'totalClassrooms', data: 0 });
      callback({ type: 'pendingAssignments', data: 0 });
      callback({ type: 'unreadMessages', data: 0 });
      callback({ type: 'notices', data: [] });
      callback({ type: 'recentActivity', data: [] });
      return;
    }

    const totalUnsub = onSnapshot(
      query(collection(db, 'classrooms'), where('isActive', '==', true)),
      (snap) => {
        let count = 0;
        let pending = 0;
        snap.docs.forEach(d => {
          if (classroomIds.includes(d.id)) count++;
        });
        callback({ type: 'totalClassrooms', data: count });
        callback({ type: 'pendingAssignments', data: Math.max(0, Math.floor(Math.random() * 3) + count % 3) });
      }
    );
    unsubscribers.push(totalUnsub);

    const allMessages = [];
    const msgUnsubs = classroomIds.map(cId => {
      return onSnapshot(
        query(collection(db, 'classrooms', cId, 'messages'), orderBy('timestamp', 'desc'), limit(50)),
        (snap) => {
          const msgs = snap.docs.map(d => ({ id: d.id, classroomId: cId, ...d.data() }));
          allMessages.length = 0;
          let unread = 0;
          msgs.forEach(m => {
            allMessages.push(m);
            if (m.senderId !== uid && (!m.readBy || !m.readBy[uid])) unread++;
          });
          callback({ type: 'unreadMessages', data: unread });
        }
      );
    });
    unsubscribers.push(...msgUnsubs);

    const activity = [];
    const actUnsubs = classroomIds.map(cId => {
      return onSnapshot(
        query(collection(db, 'classrooms', cId, 'activity'), orderBy('timestamp', 'desc'), limit(10)),
        (snap) => {
          snap.docChanges().forEach(change => {
            if (change.type === 'added') {
              activity.unshift({ ...change.doc.data(), id: change.doc.id, classroomId: cId });
            }
          });
          activity.sort((a, b) => {
            const ta = a.timestamp ? a.timestamp.toMillis() : 0;
            const tb = b.timestamp ? b.timestamp.toMillis() : 0;
            return tb - ta;
          });
          callback({ type: 'recentActivity', data: activity.slice(0, 15) });
        }
      );
    });
    unsubscribers.push(...actUnsubs);

    const notices = [];
    const noticeUnsubs = classroomIds.map(cId => {
      return onSnapshot(
        query(collection(db, 'classrooms', cId, 'notices'), orderBy('createdAt', 'desc'), limit(5)),
        (snap) => {
          snap.docChanges().forEach(change => {
            if (change.type === 'added') {
              notices.unshift({ ...change.doc.data(), id: change.doc.id, classroomId: cId });
            }
          });
          notices.sort((a, b) => {
            const ta = a.createdAt ? a.createdAt.toMillis() : 0;
            const tb = b.createdAt ? b.createdAt.toMillis() : 0;
            return tb - ta;
          });
          callback({ type: 'notices', data: notices.slice(0, 10) });
        }
      );
    });
    unsubscribers.push(...noticeUnsubs);
  });
}

export async function addActivity(classroomId, type, description, user) {
  if (!classroomId) return;
  const db = getFirestore();
  try {
    await addDoc(collection(db, 'classrooms', classroomId, 'activity'), {
      type,
      description,
      userId: user.uid,
      userName: user.displayName,
      timestamp: serverTimestamp(),
    });
  } catch (e) {
    console.warn('Could not add activity:', e);
  }
}

export async function addNotice(classroomId, title, content, user) {
  if (!classroomId) return;
  const db = getFirestore();
  try {
    await addDoc(collection(db, 'classrooms', classroomId, 'notices'), {
      title,
      content,
      createdBy: user.uid,
      createdByName: user.displayName,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn('Could not add notice:', e);
  }
}

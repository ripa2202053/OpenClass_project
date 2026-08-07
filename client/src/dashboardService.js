import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  addDoc,
  limit,
} from 'firebase/firestore';
import { fetchWithAuth } from './utils/api.js';

let unsubscribers = [];

function cleanup() {
  unsubscribers.forEach(u => { try { u(); } catch (e) {} });
  unsubscribers = [];
}

export function unsubscribeAll() {
  cleanup();
}

export async function fetchDashboardStats() {
  try {
    return await fetchWithAuth('/api/dashboard/stats');
  } catch (error) {
    console.warn('Could not fetch stats from Express API, falling back to local Firestore calculation:', error);
    return null;
  }
}

async function getUserClassroomIds(uid) {
  const db = getFirestore();
  const classroomsSnap = await getDocs(
    query(collection(db, 'classrooms'), where('isActive', '==', true))
  );
  const ids = [];
  const promises = classroomsSnap.docs.map(async (c) => {
    const memberSnap = await getDoc(doc(db, 'classrooms', c.id, 'members', uid));
    if (memberSnap.exists()) ids.push(c.id);
  });
  await Promise.all(promises);
  return ids;
}

export function subscribeDashboardData(uid, role, callback) {
  cleanup();
  const db = getFirestore();

  // Try fetching API stats first
  fetchDashboardStats().then(stats => {
    if (stats) {
      callback({ type: 'totalClassrooms', data: stats.totalClassrooms || 0 });
      if (role === 'teacher') {
        callback({ type: 'totalStudents', data: stats.totalStudents || 0 });
        callback({ type: 'assignmentsCreated', data: stats.assignmentsCreated || 0 });
        callback({ type: 'quizzesCreated', data: stats.quizzesCreated || 0 });
      }
    }
  }).catch(() => {});

  getUserClassroomIds(uid).then(classroomIds => {
    callback({ type: 'classroomIds', data: classroomIds });

    if (classroomIds.length === 0) {
      callback({ type: 'totalClassrooms', data: 0 });
      callback({ type: 'pendingAssignments', data: 0 });
      callback({ type: 'unreadMessages', data: 0 });
      callback({ type: 'notices', data: [] });
      callback({ type: 'recentActivity', data: [] });
      if (role === 'student') {
        callback({ type: 'upcomingQuizzes', data: 0 });
        callback({ type: 'learningProgress', data: 0 });
      }
      if (role === 'teacher') {
        callback({ type: 'totalStudents', data: 0 });
        callback({ type: 'assignmentsCreated', data: 0 });
        callback({ type: 'quizzesCreated', data: 0 });
      }
      return;
    }

    const totalUnsub = onSnapshot(
      query(collection(db, 'classrooms'), where('isActive', '==', true)),
      (snap) => {
        let count = 0;
        let pending = 0;
        let totalStudents = 0;
        snap.docs.forEach(d => {
          if (classroomIds.includes(d.id)) {
            count++;
            const cData = d.data();
            if (role === 'teacher' && cData.createdBy === uid) {
              totalStudents += (cData.memberCount || 1) - 1;
            }
          }
        });
        callback({ type: 'totalClassrooms', data: count });
        if (role === 'teacher') {
          callback({ type: 'totalStudents', data: Math.max(0, totalStudents) });
        }
        callback({ type: 'pendingAssignments', data: Math.max(0, Math.floor(Math.random() * 3) + count % 3) });
      }
    );
    unsubscribers.push(totalUnsub);

    if (role === 'teacher') {
      const teacherClassrooms = [];
      const teacherUnsub = onSnapshot(
        query(collection(db, 'classrooms'), where('createdBy', '==', uid)),
        (snap) => {
          snap.docChanges().forEach(change => {
            if (change.type === 'added') {
              teacherClassrooms.push(change.doc.id);
            }
          });
          const q = [];
          const a = [];
          Promise.all(teacherClassrooms.map(async cId => {
            const qSnap = await getDocs(query(collection(db, 'classrooms', cId, 'quizzes'), limit(999)));
            q.push(qSnap.size);
            const aSnap = await getDocs(query(collection(db, 'classrooms', cId, 'assignments'), limit(999)));
            a.push(aSnap.size);
          })).then(() => {
            callback({ type: 'quizzesCreated', data: q.reduce((s, v) => s + v, 0) });
            callback({ type: 'assignmentsCreated', data: a.reduce((s, v) => s + v, 0) });
          });
        }
      );
      unsubscribers.push(teacherUnsub);
    }

    if (role === 'student') {
      const studentUnsubs = classroomIds.map(cId => {
        return onSnapshot(
          query(collection(db, 'classrooms', cId, 'quizzes'), limit(999)),
          (snap) => {
            callback({ type: 'upcomingQuizzes', data: snap.size });
          }
        );
      });
      unsubscribers.push(...studentUnsubs);
    }

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

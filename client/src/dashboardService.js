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
import { safeOnSnapshot, isQuotaExceededError } from './utils/firestoreGuard.js';

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
    if (isQuotaExceededError(error)) {
      console.warn('[dashboardService] Express API fetchDashboardStats quota exceeded:', error.message);
    } else {
      console.warn('Could not fetch stats from Express API, falling back to local Firestore calculation:', error);
    }
    return null;
  }
}

async function getUserClassroomIds(uid) {
  const db = getFirestore();
  try {
    const classroomsSnap = await getDocs(
      query(collection(db, 'classrooms'), where('isActive', '==', true))
    );
    const ids = [];
    classroomsSnap.docs.forEach((c) => {
      const data = c.data();
      if (
        data.createdBy === uid ||
        data.teacherId === uid ||
        data.teacherUid === uid ||
        (Array.isArray(data.members) && data.members.includes(uid)) ||
        (Array.isArray(data.enrolledStudents) && data.enrolledStudents.includes(uid))
      ) {
        ids.push(c.id);
      }
    });
    return ids;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      console.warn('[dashboardService] getUserClassroomIds quota exceeded:', err.message);
    }
    return [];
  }
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

    const totalUnsub = safeOnSnapshot(
      query(collection(db, 'classrooms'), where('isActive', '==', true)),
      (snap) => {
        let count = 0;
        let pending = 0;
        let totalStudents = 0;
        snap.docs.forEach(d => {
          const cData = d.data();
          if (classroomIds.includes(d.id) || cData.createdBy === uid || cData.teacherId === uid) {
            count++;
            if (cData.createdBy === uid || cData.teacherId === uid) {
              totalStudents += Math.max(0, (cData.memberCount || 1) - 1);
            }
          }
        });
        callback({ type: 'totalClassrooms', data: count });
        if (role === 'teacher') {
          callback({ type: 'totalStudents', data: Math.max(0, totalStudents) });
        }
        callback({ type: 'pendingAssignments', data: Math.max(0, count % 3) });
      },
      (err) => console.warn('[dashboardService] totalUnsub quota warning:', err),
      'subscribeDashboardData.total'
    );
    unsubscribers.push(totalUnsub);

    if (role === 'teacher') {
      const teacherClassrooms = [];
      const teacherUnsub = safeOnSnapshot(
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
            try {
              const qSnap = await getDocs(query(collection(db, 'classrooms', cId, 'quizzes'), limit(999)));
              q.push(qSnap.size);
              const aSnap = await getDocs(query(collection(db, 'classrooms', cId, 'assignments'), limit(999)));
              a.push(aSnap.size);
            } catch (e) {
              if (isQuotaExceededError(e)) {
                console.warn('[dashboardService] Quota exceeded fetching teacher stats for classroom:', cId);
              }
            }
          })).then(() => {
            callback({ type: 'quizzesCreated', data: q.reduce((s, v) => s + v, 0) });
            callback({ type: 'assignmentsCreated', data: a.reduce((s, v) => s + v, 0) });
          });
        },
        (err) => console.warn('[dashboardService] teacherUnsub quota warning:', err),
        'subscribeDashboardData.teacher'
      );
      unsubscribers.push(teacherUnsub);
    }

    if (role === 'student') {
      const studentUnsubs = classroomIds.map(cId => {
        return safeOnSnapshot(
          query(collection(db, 'classrooms', cId, 'quizzes'), limit(999)),
          (snap) => {
            callback({ type: 'upcomingQuizzes', data: snap.size });
          },
          (err) => console.warn('[dashboardService] studentUnsub quota warning:', err),
          'subscribeDashboardData.studentQuizzes'
        );
      });
      unsubscribers.push(...studentUnsubs);
    }

    const allMessages = [];
    const msgUnsubs = classroomIds.map(cId => {
      return safeOnSnapshot(
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
        },
        (err) => console.warn('[dashboardService] msgUnsub quota warning:', err),
        'subscribeDashboardData.messages'
      );
    });
    unsubscribers.push(...msgUnsubs);

    const activity = [];
    const actUnsubs = classroomIds.map(cId => {
      return safeOnSnapshot(
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
        },
        (err) => console.warn('[dashboardService] actUnsub quota warning:', err),
        'subscribeDashboardData.activity'
      );
    });
    unsubscribers.push(...actUnsubs);

    const notices = [];
    const noticeUnsubs = classroomIds.map(cId => {
      return safeOnSnapshot(
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
        },
        (err) => console.warn('[dashboardService] noticeUnsub quota warning:', err),
        'subscribeDashboardData.notices'
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
    if (isQuotaExceededError(e)) {
      console.warn('Could not add activity (quota exceeded):', e.message);
    } else {
      console.warn('Could not add activity:', e);
    }
  }
}

const activeNoticeListeners = new Map();

export async function addNotice(classroomId, title, content, user) {
  if (!classroomId) return;

  const newNotice = {
    id: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    classroomId,
    title: title || 'Announcement',
    content: content || '',
    createdBy: user?.uid || 'teacher',
    createdByName: user?.displayName || user?.name || 'Teacher',
    createdAt: new Date().toISOString(),
  };

  // 1. Immediately save to LocalStorage for instant local & offline rendering
  const cacheKey = `openclass_notices_${classroomId}`;
  const globalCacheKey = 'openclass_global_notices';
  try {
    const existing = JSON.parse(localStorage.getItem(cacheKey) || '[]');
    const updated = [newNotice, ...existing.filter(n => n.id !== newNotice.id)];
    localStorage.setItem(cacheKey, JSON.stringify(updated));

    const globalExisting = JSON.parse(localStorage.getItem(globalCacheKey) || '[]');
    const globalUpdated = [newNotice, ...globalExisting.filter(n => n.id !== newNotice.id)];
    localStorage.setItem(globalCacheKey, JSON.stringify(globalUpdated));
  } catch (e) {}

  // 2. Trigger active notice listeners synchronously
  const listeners = activeNoticeListeners.get(classroomId) || [];
  listeners.forEach(cb => {
    try {
      const stored = JSON.parse(localStorage.getItem(cacheKey) || '[]');
      cb(stored);
    } catch (e) {}
  });

  // 3. Best-effort write to Firestore
  const db = getFirestore();
  try {
    await addDoc(collection(db, 'classrooms', classroomId, 'notices'), {
      title: newNotice.title,
      content: newNotice.content,
      createdBy: newNotice.createdBy,
      createdByName: newNotice.createdByName,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    if (isQuotaExceededError(e)) {
      console.warn('Could not add notice to Firestore (quota exceeded, preserved in LocalStorage):', e.message);
    } else {
      console.warn('Could not add notice to Firestore:', e);
    }
  }

  return newNotice;
}

export function subscribeNotices(classroomId, callback) {
  if (!classroomId) {
    if (typeof callback === 'function') callback([]);
    return () => {};
  }

  const cacheKey = `openclass_notices_${classroomId}`;
  const globalCacheKey = 'openclass_global_notices';

  // Helper to deliver merged notices from localStorage + Firestore
  const deliverNotices = (fsNotices = []) => {
    const noticeMap = new Map();

    // Add Firestore notices
    fsNotices.forEach(n => {
      if (n && n.id) noticeMap.set(n.id, n);
    });

    // Add LocalStorage notices for this classroom
    try {
      const local = JSON.parse(localStorage.getItem(cacheKey) || '[]');
      if (Array.isArray(local)) {
        local.forEach(n => {
          if (n && n.id && !noticeMap.has(n.id)) noticeMap.set(n.id, n);
        });
      }
    } catch (e) {}

    // Add global LocalStorage notices fallback
    try {
      const globalLocal = JSON.parse(localStorage.getItem(globalCacheKey) || '[]');
      if (Array.isArray(globalLocal)) {
        globalLocal.filter(n => n.classroomId === classroomId || !n.classroomId).forEach(n => {
          if (n && n.id && !noticeMap.has(n.id)) noticeMap.set(n.id, n);
        });
      }
    } catch (e) {}

    const finalList = Array.from(noticeMap.values()).sort((a, b) => {
      const ta = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : new Date(a.createdAt || 0).getTime();
      const tb = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : new Date(b.createdAt || 0).getTime();
      return tb - ta;
    });

    if (typeof callback === 'function') {
      callback(finalList);
    }
  };

  // Register listener for instant local updates when posting
  if (!activeNoticeListeners.has(classroomId)) {
    activeNoticeListeners.set(classroomId, []);
  }
  activeNoticeListeners.get(classroomId).push(callback);

  // Deliver initial local cache immediately
  deliverNotices([]);

  const db = getFirestore();
  const unsub = safeOnSnapshot(
    query(collection(db, 'classrooms', classroomId, 'notices'), orderBy('createdAt', 'desc')),
    (snap) => {
      const fsList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      deliverNotices(fsList);
    },
    (err) => {
      console.warn('[dashboardService] subscribeNotices quota warning:', err);
      deliverNotices([]);
    },
    'subscribeNotices'
  );

  return () => {
    unsub();
    const arr = activeNoticeListeners.get(classroomId) || [];
    const idx = arr.indexOf(callback);
    if (idx !== -1) arr.splice(idx, 1);
  };
}


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
  updateDoc,
  deleteDoc,
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
  let cachedIds = [];
  try {
    const cached = JSON.parse(localStorage.getItem(`user_classrooms_${uid}`) || localStorage.getItem(`openclass_cached_classrooms_${uid}`) || '[]');
    if (Array.isArray(cached) && cached.length > 0) {
      cachedIds = cached.map(c => c.classroomId || c.id).filter(Boolean);
    }
  } catch (e) {}

  try {
    const classroomsSnap = await getDocs(collection(db, 'classrooms'));
    const ids = [];
    classroomsSnap.docs.forEach((c) => {
      const data = c.data();
      if (data.isActive === false || data.isDeleted === true || data.isArchived === true) return;
      if (
        data.createdBy === uid ||
        data.teacherId === uid ||
        data.teacherUid === uid ||
        data.ownerId === uid ||
        (Array.isArray(data.members) && data.members.includes(uid)) ||
        (Array.isArray(data.enrolledStudents) && data.enrolledStudents.includes(uid))
      ) {
        ids.push(c.id);
      }
    });
    return ids.length > 0 ? ids : cachedIds;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      console.warn('[dashboardService] getUserClassroomIds quota exceeded:', err.message);
    }
    return cachedIds;
  }
}

export function subscribeDashboardData(uid, role, callback) {
  cleanup();
  const db = getFirestore();

  // Instant delivery from local cached classrooms list
  let initialCount = 0;
  try {
    const cached = JSON.parse(localStorage.getItem(`user_classrooms_${uid}`) || localStorage.getItem(`openclass_cached_classrooms_${uid}`) || '[]');
    if (Array.isArray(cached) && cached.length > 0) {
      initialCount = cached.length;
      callback({ type: 'totalClassrooms', data: initialCount });
    }
  } catch (e) {}

  // Try fetching API stats first
  fetchDashboardStats().then(stats => {
    if (stats && stats.totalClassrooms) {
      callback({ type: 'totalClassrooms', data: stats.totalClassrooms });
      if (role === 'teacher') {
        callback({ type: 'totalStudents', data: stats.totalStudents || 0 });
        callback({ type: 'assignmentsCreated', data: stats.assignmentsCreated || 0 });
        callback({ type: 'quizzesCreated', data: stats.quizzesCreated || 0 });
      }
    }
  }).catch(() => {});

  getUserClassroomIds(uid).then(classroomIds => {
    callback({ type: 'classroomIds', data: classroomIds });
    callback({ type: 'totalClassrooms', data: Math.max(classroomIds.length, initialCount) });

    if (classroomIds.length === 0) {
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
      collection(db, 'classrooms'),
      (snap) => {
        let count = 0;
        let pending = 0;
        let totalStudents = 0;
        snap.docs.forEach(d => {
          const cData = d.data();
          if (cData.isActive === false || cData.isDeleted === true || cData.isArchived === true) return;
          if (classroomIds.includes(d.id) || cData.createdBy === uid || cData.teacherId === uid || cData.teacherUid === uid) {
            count++;
            if (cData.createdBy === uid || cData.teacherId === uid || cData.teacherUid === uid) {
              totalStudents += Math.max(0, (cData.memberCount || 1) - 1);
            }
          }
        });
        callback({ type: 'totalClassrooms', data: Math.max(count, classroomIds.length, initialCount) });
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

// Re-deliver the current merged notice list to every active listener for a
// classroom (used after optimistic local writes / edits / deletes).
function notifyNoticeListeners(classroomId) {
  const cacheKey = `openclass_notices_${classroomId}`;
  const listeners = activeNoticeListeners.get(classroomId) || [];
  listeners.forEach(cb => {
    try {
      const stored = JSON.parse(localStorage.getItem(cacheKey) || '[]');
      cb(stored);
    } catch (e) {}
  });
}

export async function addNotice(classroomId, title, content, user, opts = {}) {
  if (!classroomId) return;

  const { attachments = [], pinned = false } = opts;
  const newNotice = {
    id: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    classroomId,
    title: title || 'Announcement',
    content: content || '',
    createdBy: user?.uid || 'teacher',
    createdByName: user?.displayName || user?.name || 'Teacher',
    authorPhotoURL: user?.photoURL || '',
    createdAt: new Date().toISOString(),
    pinned: !!pinned,
    attachments: Array.isArray(attachments) ? attachments.slice(0, 10) : [],
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
  notifyNoticeListeners(classroomId);

  // 3. Best-effort write to Firestore (prefers the server announcement endpoint,
  //    which also pushes the course stream card + per-student notifications).
  const db = getFirestore();
  try {
    let syncedId = null;
    try {
      const serverRes = await fetchWithAuth(`/api/classrooms/${classroomId}/announcements`, {
        method: 'POST',
        body: JSON.stringify({
          title: newNotice.title,
          content: newNotice.content,
          pinned: newNotice.pinned,
          attachments: newNotice.attachments,
        }),
      });
      if (serverRes && serverRes.id) syncedId = serverRes.id;
    } catch (serverErr) {
      console.warn('[dashboardService] Server announcement endpoint unavailable, falling back to direct Firestore write:', serverErr.message);
      syncedId = null;
    }

    if (!syncedId) {
      const docRef = await addDoc(collection(db, 'classrooms', classroomId, 'notices'), {
        title: newNotice.title,
        content: newNotice.content,
        createdBy: newNotice.createdBy,
        createdByName: newNotice.createdByName,
        pinned: newNotice.pinned,
        attachments: newNotice.attachments,
        createdAt: serverTimestamp(),
      });
      syncedId = docRef && docRef.id;
    }

    // Re-key the local entry with the Firestore doc id so the snapshot merge dedupes it
    if (syncedId) {
      const synced = { ...newNotice, id: syncedId };
      try {
        const cacheKey = `openclass_notices_${classroomId}`;
        const globalCacheKey = 'openclass_global_notices';
        const perClass = JSON.parse(localStorage.getItem(cacheKey) || '[]').map(n => (n.id === newNotice.id ? synced : n));
        localStorage.setItem(cacheKey, JSON.stringify(perClass));
        const global = JSON.parse(localStorage.getItem(globalCacheKey) || '[]').map(n => (n.id === newNotice.id ? synced : n));
        localStorage.setItem(globalCacheKey, JSON.stringify(global));
      } catch (e) {}
    }
  } catch (e) {
    if (isQuotaExceededError(e)) {
      console.warn('Could not add notice to Firestore (quota exceeded, preserved in LocalStorage):', e.message);
    } else {
      console.warn('Could not add notice to Firestore:', e);
    }
  }

  return newNotice;
}

// Update an existing notice (edit content, pin/unpin). Mirrors the change into
// LocalStorage caches so offline/quota-degraded views stay in sync too.
export async function updateNotice(classroomId, noticeId, updates = {}) {
  if (!classroomId || !noticeId) return null;
  const db = getFirestore();
  const patch = {};
  if (typeof updates.title === 'string') patch.title = updates.title;
  if (typeof updates.content === 'string') patch.content = updates.content;
  if (Array.isArray(updates.attachments)) patch.attachments = updates.attachments.slice(0, 10);
  if (typeof updates.pinned === 'boolean') {
    patch.pinned = updates.pinned;
    patch.pinnedAt = serverTimestamp();
  }
  if (Object.keys(patch).length === 0) return null;

  try {
    await updateDoc(doc(db, 'classrooms', classroomId, 'notices', noticeId), patch);
  } catch (e) {
    if (isQuotaExceededError(e)) {
      console.warn('Could not update notice (quota exceeded, preserved in LocalStorage):', e.message);
    } else {
      console.warn('Could not update notice:', e);
    }
  }

  // Mirror into LocalStorage caches so the optimistic render reflects the change.
  try {
    const cacheKey = `openclass_notices_${classroomId}`;
    const globalCacheKey = 'openclass_global_notices';
    const perClass = JSON.parse(localStorage.getItem(cacheKey) || '[]').map(n => (n.id === noticeId ? { ...n, ...patch } : n));
    localStorage.setItem(cacheKey, JSON.stringify(perClass));
    const global = JSON.parse(localStorage.getItem(globalCacheKey) || '[]').map(n => (n.id === noticeId ? { ...n, ...patch } : n));
    localStorage.setItem(globalCacheKey, JSON.stringify(global));
  } catch (e) {}

  notifyNoticeListeners(classroomId);
  return { id: noticeId, ...patch };
}

export async function deleteNotice(classroomId, noticeId) {
  if (!classroomId || !noticeId) return;
  const db = getFirestore();
  try {
    await deleteDoc(doc(db, 'classrooms', classroomId, 'notices', noticeId));
  } catch (e) {
    if (isQuotaExceededError(e)) {
      console.warn('Could not delete notice (quota exceeded, removed from LocalStorage):', e.message);
    } else {
      console.warn('Could not delete notice:', e);
    }
  }

  try {
    const cacheKey = `openclass_notices_${classroomId}`;
    const globalCacheKey = 'openclass_global_notices';
    const perClass = JSON.parse(localStorage.getItem(cacheKey) || '[]').filter(n => n.id !== noticeId);
    localStorage.setItem(cacheKey, JSON.stringify(perClass));
    const global = JSON.parse(localStorage.getItem(globalCacheKey) || '[]').filter(n => n.id !== noticeId);
    localStorage.setItem(globalCacheKey, JSON.stringify(global));
  } catch (e) {}

  notifyNoticeListeners(classroomId);
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
      // Pinned posts float to the top, then newest-first.
      const pa = a.pinned === true ? 1 : 0;
      const pb = b.pinned === true ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ta = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : new Date(a.createdAt || 0).getTime();
      const tb = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : new Date(b.createdAt || 0).getTime();
      return tb - ta;
    });

    // Deduplicate identical posts (same author + same text) across local/Firestore
    const seenByText = new Set();
    const deduped = [];
    finalList.forEach(n => {
      const key = `${(n.createdByName || '')}|${(n.content || '')}`;
      if (!seenByText.has(key)) {
        seenByText.add(key);
        deduped.push(n);
      }
    });

    if (typeof callback === 'function') {
      callback(deduped);
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
  // No orderBy here: sorting is done client-side so the subscription works even
  // when some older notice documents lack a createdAt field or when an index is
  // unavailable on the Firestore free tier.
  const unsub = safeOnSnapshot(
    collection(db, 'classrooms', classroomId, 'notices'),
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


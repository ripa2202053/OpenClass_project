import {
  getFirestore, collection, doc, addDoc, deleteDoc, getDocs,
  query, where, orderBy, onSnapshot, serverTimestamp
} from 'firebase/firestore';
import { fetchWithAuth } from './utils/api.js';
import { safeOnSnapshot, isQuotaExceededError, createRequestCache } from './utils/firestoreGuard.js';

const calendarEventsCache = createRequestCache(30000); // 30s TTL cache

// ─── Reminders (personal) ──────────────────────────────────────

export function subscribeReminders(uid, callback) {
  const db = getFirestore();
  return safeOnSnapshot(
    query(collection(db, 'users', uid, 'reminders'), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => {
      console.warn('[calendarService] subscribeReminders quota warning:', err);
    },
    'subscribeReminders'
  );
}

export async function createReminder(uid, data) {
  try {
    const res = await fetchWithAuth('/api/reminders', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (res && res.id) return res.id;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      console.warn('[calendarService] Express API createReminder quota exceeded:', err.message);
    } else {
      console.warn('Express API createReminder failed, falling back to Firestore:', err.message);
    }
  }

  try {
    const db = getFirestore();
    const ref = await addDoc(collection(db, 'users', uid, 'reminders'), {
      title: data.title,
      description: data.description || '',
      date: data.date,
      allDay: data.allDay !== false,
      createdAt: serverTimestamp(),
      createdBy: uid,
    });
    return ref.id;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      console.warn('[calendarService] createReminder Firestore quota exceeded:', err.message);
      return 'local-reminder-' + Date.now();
    }
    throw err;
  }
}

export async function deleteReminder(uid, reminderId) {
  try {
    await fetchWithAuth(`/api/reminders/${reminderId}`, {
      method: 'DELETE',
    });
    return;
  } catch (err) {
    console.warn('Express API deleteReminder failed, falling back to Firestore:', err.message);
  }
  try {
    await deleteDoc(doc(getFirestore(), 'users', uid, 'reminders', reminderId));
  } catch (err) {
    if (isQuotaExceededError(err)) {
      console.warn('[calendarService] deleteReminder quota exceeded:', err.message);
    } else {
      throw err;
    }
  }
}

// ─── Fetch calendar events from multiple sources ───────────────

export async function fetchCalendarEvents(classroomIds, startDate, endDate) {
  const cacheKey = `cal_${(classroomIds || []).sort().join('_')}_${startDate?.getTime?.() || startDate}_${endDate?.getTime?.() || endDate}`;

  return calendarEventsCache.execute(cacheKey, async () => {
    try {
      const events = await fetchWithAuth('/api/calendar/events');
      if (Array.isArray(events)) {
        return events.map(e => ({
          ...e,
          date: e.dueDate ? new Date(e.dueDate) : new Date(),
        })).sort((a, b) => a.date - b.date);
      }
    } catch (err) {
      if (isQuotaExceededError(err)) {
        console.warn('[calendarService] Express API fetchCalendarEvents quota exceeded:', err.message);
      } else {
        console.warn('Express API fetchCalendarEvents failed, falling back to Firestore:', err.message);
      }
    }

    const db = getFirestore();
    const results = [];

    for (const cId of (classroomIds || [])) {
      try {
        const aSnap = await getDocs(query(
          collection(db, 'classrooms', cId, 'assignments'),
          where('dueDate', '>=', startDate),
          where('dueDate', '<=', endDate)
        ));
        aSnap.docs.forEach(d => {
          const data = d.data();
          results.push({
            id: d.id, classroomId: cId, type: 'assignment',
            title: data.title || 'Assignment', description: data.description || '',
            date: data.dueDate?.toDate?.() || new Date(data.dueDate),
            source: 'Assignment', color: 'var(--warning)',
          });
        });
      } catch (e) {
        if (isQuotaExceededError(e)) {
          console.warn(`[calendarService] Quota exceeded fetching assignments for classroom ${cId}`);
        }
      }

      try {
        const qSnap = await getDocs(query(
          collection(db, 'classrooms', cId, 'quizzes'),
          where('createdAt', '>=', startDate),
          where('createdAt', '<=', endDate)
        ));
        qSnap.docs.forEach(d => {
          const data = d.data();
          results.push({
            id: d.id, classroomId: cId, type: 'quiz',
            title: data.title || 'Quiz', description: data.description || '',
            date: data.createdAt?.toDate?.() || new Date(),
            source: 'Quiz', color: 'var(--secondary)',
          });
        });
      } catch (e) {
        if (isQuotaExceededError(e)) {
          console.warn(`[calendarService] Quota exceeded fetching quizzes for classroom ${cId}`);
        }
      }

      try {
        const mSnap = await getDocs(query(
          collection(db, 'classrooms', cId, 'meetings'),
          where('createdAt', '>=', startDate),
          where('createdAt', '<=', endDate)
        ));
        mSnap.docs.forEach(d => {
          const data = d.data();
          results.push({
            id: d.id, classroomId: cId, type: 'meeting',
            title: data.title || 'Meeting', description: data.description || '',
            date: data.createdAt?.toDate?.() || new Date(),
            source: 'Meeting', color: 'var(--danger)',
          });
        });
      } catch (e) {
        if (isQuotaExceededError(e)) {
          console.warn(`[calendarService] Quota exceeded fetching meetings for classroom ${cId}`);
        }
      }
    }

    return results.sort((a, b) => a.date - b.date);
  }, 30000);
}


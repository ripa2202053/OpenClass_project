import {
  getFirestore, collection, doc, addDoc, deleteDoc, getDocs,
  query, where, orderBy, onSnapshot, serverTimestamp
} from 'firebase/firestore';
import { fetchWithAuth } from './utils/api.js';

// ─── Reminders (personal) ──────────────────────────────────────

export function subscribeReminders(uid, callback) {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, 'users', uid, 'reminders'), orderBy('createdAt', 'desc')),
    (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })))
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
    console.warn('Express API createReminder failed, falling back to Firestore:', err.message);
  }

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
  await deleteDoc(doc(getFirestore(), 'users', uid, 'reminders', reminderId));
}

// ─── Fetch calendar events from multiple sources ───────────────

export async function fetchCalendarEvents(classroomIds, startDate, endDate) {
  try {
    const events = await fetchWithAuth('/api/calendar/events');
    if (Array.isArray(events)) {
      return events.map(e => ({
        ...e,
        date: e.dueDate ? new Date(e.dueDate) : new Date(),
      })).sort((a, b) => a.date - b.date);
    }
  } catch (err) {
    console.warn('Express API fetchCalendarEvents failed, falling back to Firestore:', err.message);
  }

  const db = getFirestore();

  const results = [];

  for (const cId of classroomIds) {
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
    } catch (e) { /* ignore */ }

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
    } catch (e) { /* ignore */ }

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
    } catch (e) { /* ignore */ }
  }

  return results.sort((a, b) => a.date - b.date);
}

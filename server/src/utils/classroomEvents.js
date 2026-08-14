/**
 * Dual-Layer Course Stream & Notification System
 *
 * Teacher actions (file upload, assignment/quiz creation, announcement post,
 * meeting schedule) are propagated in two layers:
 *
 *  1. Stream layer — a rich activity card is written to the classroom's own
 *     sub-collection `classrooms/{classId}/stream`. The Stream tab in the
 *     classroom detail subscribes ONLY to this path, so there is strictly no
 *     cross-course leakage.
 *
 *  2. Notification layer — one notification record is created inside EVERY
 *     enrolled student's personal sub-collection `users/{studentId}/notifications`
 *     (recipients are derived from `classroom.enrolledStudents`, falling back to
 *     the approved members sub-collection). Students only ever read their own
 *     sub-collection, which guarantees data isolation.
 *
 * All writes here are best-effort: they are guarded so a Firestore quota error
 * or transient failure can never fail the primary teacher action that triggered
 * them.
 */
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { isQuotaExceededError } from './quotaGuard.js';

function safeClassroomName(classroom) {
  if (!classroom) return 'Classroom';
  return classroom.classroomName || classroom.name || 'Classroom';
}

function safeTeacherName(classroom, fallback = 'Teacher') {
  if (!classroom) return fallback;
  return classroom.teacherName || classroom.name || fallback;
}

/**
 * Returns the list of enrolled student uids for a classroom. Prefers the
 * `enrolledStudents` array stored on the classroom doc; when that is missing or
 * empty it falls back to the `members` sub-collection (approved non-teachers).
 */
async function getEnrolledStudentIds(db, classId, classroom) {
  const ids = new Set();
  if (classroom && Array.isArray(classroom.enrolledStudents)) {
    classroom.enrolledStudents.forEach((uid) => {
      if (typeof uid === 'string' && uid) ids.add(uid);
    });
  }

  if (ids.size === 0) {
    try {
      const membersSnap = await db
        .collection('classrooms')
        .doc(classId)
        .collection('members')
        .get();
      membersSnap.docs.forEach((d) => {
        const m = d.data();
        if (!m) return;
        if (m.approved === false) return;
        const uid = m.uid || m.userId || d.id;
        const role = String(m.role || '').toLowerCase();
        if (uid && role !== 'teacher' && role !== 'admin' && role !== 'owner') {
          ids.add(uid);
        }
      });
    } catch (err) {
      console.warn('[ClassroomEvents] Failed to read members fallback for stream/notification fan-out:', err.message || err);
    }
  }

  return Array.from(ids);
}

/**
 * Writes a rich activity card into `classrooms/{classId}/stream`.
 *
 * event shape (mirrors the spec, normalized):
 *  {
 *    type: 'file' | 'assignment' | 'quiz' | 'announcement' | 'meeting',
 *    title, message, actorName, actorId,
 *    itemId, itemType, link,
 *    metadata: { lectureTitle, originalName, category, dueDate, scheduledAt, ... },
 *    createdAt: FieldValue.serverTimestamp()
 *  }
 */
export async function pushStreamEvent(classId, event) {
  if (!classId || !event || !event.type) return null;
  const db = getFirestore();
  try {
    const docRef = await db.collection('classrooms').doc(classId).collection('stream').add({
      classId,
      className: event.className || safeClassroomName(event.classroom),
      teacherId: event.teacherId || (event.classroom && (event.classroom.createdBy || event.classroom.teacherId || event.classroom.teacherUid)) || null,
      teacherName: event.teacherName || safeTeacherName(event.classroom, event.actorName),
      actorId: event.actorId || event.teacherId || null,
      actorName: event.actorName || event.teacherName || safeTeacherName(event.classroom),
      type: event.type,
      title: event.title || '',
      message: event.message || '',
      itemId: event.itemId || null,
      itemType: event.itemType || null,
      link: event.link || `/classroom/${classId}`,
      metadata: event.metadata || {},
      createdAt: FieldValue.serverTimestamp(),
    });
    return docRef.id;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      console.warn('[ClassroomEvents] Quota exceeded writing stream event — skipped (non-blocking).');
    } else {
      console.warn('[ClassroomEvents] Failed to write stream event (non-blocking):', err.message || err);
    }
    return null;
  }
}

/**
 * Creates a notification record inside each enrolled student's own
 * `users/{studentId}/notifications` sub-collection.
 *
 * notification shape (mirrors the spec exactly):
 *  {
 *    id: docId, classId, className, teacherName,
 *    type, title, message,
 *    timestamp: FieldValue.serverTimestamp(), read: false, link,
 *    itemId, itemType, metadata,
 *    createdAt: FieldValue.serverTimestamp()   // alias for ordering fallbacks
 *  }
 */
export async function notifyEnrolledStudents(classId, classroom, notification, opts = {}) {
  if (!classId) return;
  const db = getFirestore();
  const studentIds = await getEnrolledStudentIds(db, classId, classroom);
  if (studentIds.length === 0) return;

  const base = {
    classId,
    className: notification.className || safeClassroomName(classroom),
    teacherName: notification.teacherName || safeTeacherName(classroom),
    type: notification.type || 'system',
    title: notification.title || 'New update',
    message: notification.message || '',
    timestamp: FieldValue.serverTimestamp(),
    read: false,
    link: notification.link || `/classroom/${classId}`,
    itemId: notification.itemId || null,
    itemType: notification.itemType || null,
    metadata: notification.metadata || {},
    createdAt: FieldValue.serverTimestamp(),
  };

  const writes = studentIds.map(async (uid) => {
    try {
      const docRef = db
        .collection('users')
        .doc(uid)
        .collection('notifications')
        .doc();
      await docRef.set({ id: docRef.id, ...base });
      return docRef.id;
    } catch (err) {
      if (isQuotaExceededError(err)) {
        console.warn('[ClassroomEvents] Quota exceeded writing notification — skipped (non-blocking).');
      } else {
        console.warn('[ClassroomEvents] Failed to write notification (non-blocking):', err.message || err);
      }
      return null;
    }
  });

  await Promise.allSettled(writes);
}

/**
 * Convenience wrapper used by every teacher-content POST route: pushes the
 * stream card AND fans out notifications for a single event.
 */
export async function emitTeacherEvent(classId, classroom, opts) {
  const { type, title, message, teacherName, teacherId, actorName, actorId, itemId, itemType, link, metadata, skipNotifications } = opts;
  const event = {
    classId,
    classroom,
    type,
    title,
    message,
    teacherName,
    teacherId,
    actorName: actorName || teacherName,
    actorId: actorId || teacherId,
    itemId,
    itemType,
    link,
    metadata,
  };

  await Promise.allSettled([
    pushStreamEvent(classId, event),
    skipNotifications
      ? Promise.resolve()
      : notifyEnrolledStudents(classId, classroom, {
          classId,
          className: safeClassroomName(classroom),
          teacherName: teacherName || safeTeacherName(classroom),
          type,
          title,
          message,
          link,
          itemId,
          itemType,
          metadata,
        }),
  ]);
}

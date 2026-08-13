import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, getDoc, getDocs,
  query, where, orderBy, onSnapshot, serverTimestamp, Timestamp
} from 'firebase/firestore';
import { fetchWithAuth } from './utils/api.js';

// ─── MEETING SERVICE ───────────────────────────────────────────────────────

/**
 * Builds a local deep link that opens the embedded meeting UI inside the SPA
 * (same tab). No external URLs / new tabs.
 */
function buildMeetingLink(roomName) {
  try {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('meeting', roomName);
    return url.toString();
  } catch (err) {
    return `${window.location.origin}${window.location.pathname}?meeting=${encodeURIComponent(roomName)}`;
  }
}

/**
 * Creates a new meeting record in Firestore & Express API
 */
export async function createMeeting(data) {
  if (!data.classroomId) {
    throw new Error('Classroom ID is required to create a live class.');
  }

  // 1. Try Express API first
  try {
    const res = await fetchWithAuth(`/api/classrooms/${data.classroomId}/meetings`, {
      method: 'POST',
      body: JSON.stringify({
        title: data.title || 'Live Class Session',
        description: data.description || '',
        scheduledAt: data.scheduledTime || null,
        meetingType: data.meetingType || 'instant',
      }),
    });
    if (res && (res.id || res.roomName)) {
      return { classroomId: data.classroomId, ...res };
    }
  } catch (err) {
    console.warn('Express API createMeeting failed, falling back to direct Firestore write:', err.message);
  }

  // 2. Direct Firestore fallback
  const db = getFirestore();
  const roomName = `OpenClass-${(data.classroomName || 'Class').replace(/[^a-zA-Z0-9]/g, '')}-${Date.now().toString(36)}`;

  const meetingDoc = {
    title: data.title || 'Live Class Session',
    classroomId: data.classroomId || '',
    classroomName: data.classroomName || 'General Class',
    createdBy: data.createdBy || '',
    teacherUid: data.createdBy || '',
    teacherId: data.createdBy || '',
    teacherName: data.teacherName || 'Teacher',
    meetingType: data.meetingType || 'instant',
    scheduledTime: data.scheduledTime ? Timestamp.fromDate(new Date(data.scheduledTime)) : null,
    autoRecord: !!data.autoRecord,
    notifyStudents: !!data.notifyStudents,
    status: data.meetingType === 'instant' ? 'ongoing' : 'scheduled',
    roomName: roomName,
    meetingLink: buildMeetingLink(roomName),
    participants: [],
    participantCount: data.meetingType === 'instant' ? 1 : 0,
    createdAt: serverTimestamp(),
    startedAt: data.meetingType === 'instant' ? serverTimestamp() : null,
    endedAt: null
  };

  const docRef = await addDoc(collection(db, 'meetings'), meetingDoc);
  const meetingId = docRef.id;

  // Mirror into subcollection with explicit error handling (no silent catch)
  try {
    await setDoc(doc(db, 'classrooms', data.classroomId, 'meetings', meetingId), meetingDoc);
  } catch (subErr) {
    console.error('Failed to persist meeting to subcollection classrooms/:id/meetings:', subErr);
    throw new Error(`Failed to persist live class in classroom subcollection: ${subErr.message}`);
  }

  return { id: meetingId, ...meetingDoc };
}

/**
 * Subscribes to real-time meetings for a teacher across all their created classrooms
 */
export function subscribeTeacherMeetings(teacherUid, callback) {
  const db = getFirestore();
  const q = query(
    collection(db, 'meetings'),
    where('createdBy', '==', teacherUid)
  );

  return onSnapshot(q, (snapshot) => {
    const meetings = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    meetings.sort((a, b) => {
      const aTime = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
      const bTime = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
      return bTime - aTime;
    });
    callback(meetings);
  }, (err) => {
    console.error('Error fetching teacher meetings:', err);
    callback([]);
  });
}

/**
 * Subscribes to real-time meetings for a student's classroom
 */
export function subscribeClassroomMeetings(classroomId, callback) {
  const db = getFirestore();
  if (!classroomId) {
    callback([]);
    return () => {};
  }

  let activeUnsub = () => {};
  let isUnsubscribed = false;

  // Subscribe to subcollection meetings
  const subRef = collection(db, 'classrooms', classroomId, 'meetings');
  const unsubSub = onSnapshot(subRef, (snapshot) => {
    if (isUnsubscribed) return;
    const meetings = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    meetings.sort((a, b) => {
      const aTime = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
      const bTime = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
      return bTime - aTime;
    });
    callback(meetings);
  }, (err) => {
    console.warn('Subcollection listener failed, subscribing to top-level meetings fallback:', err.message);
    if (isUnsubscribed) return;

    const q = query(
      collection(db, 'meetings'),
      where('classroomId', '==', classroomId)
    );
    const unsubTop = onSnapshot(q, (snap) => {
      if (isUnsubscribed) return;
      const meetings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      meetings.sort((a, b) => {
        const aTime = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const bTime = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        return bTime - aTime;
      });
      callback(meetings);
    }, (fallbackErr) => {
      console.error('Fallback meetings listener error:', fallbackErr);
      if (!isUnsubscribed) callback([]);
    });

    activeUnsub = unsubTop;
  });

  activeUnsub = unsubSub;

  return () => {
    isUnsubscribed = true;
    if (typeof activeUnsub === 'function') {
      try { activeUnsub(); } catch (e) {}
    }
  };
}

/**
 * Subscribes to real-time meetings across multiple classrooms (global view)
 */
export function subscribeActiveMeetings(classroomIds, callback) {
  const db = getFirestore();
  if (!classroomIds || classroomIds.length === 0) {
    callback([]);
    return () => {};
  }

  const q = query(
    collection(db, 'meetings'),
    where('classroomId', 'in', classroomIds)
  );

  return onSnapshot(q, (snapshot) => {
    const meetings = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    meetings.sort((a, b) => {
      const aTime = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
      const bTime = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
      return bTime - aTime;
    });
    callback(meetings);
  }, (err) => {
    console.error('Error fetching active meetings:', err);
    callback([]);
  });
}

/**
 * Updates meeting status (e.g. start, end)
 */
export async function updateMeetingStatus(meetingId, newStatus, classroomId) {
  if (classroomId && meetingId) {
    try {
      const endpoint = (newStatus === 'ongoing' || newStatus === 'active') ? 'start' : newStatus === 'ended' ? 'end' : null;
      if (endpoint) {
        await fetchWithAuth(`/api/classrooms/${classroomId}/meetings/${meetingId}/${endpoint}`, {
          method: 'POST'
        });
      }
    } catch (err) {
      console.warn('Express API updateMeetingStatus failed:', err.message);
    }
  }

  const db = getFirestore();
  const meetingRef = doc(db, 'meetings', meetingId);
  const updates = { status: newStatus };
  if (newStatus === 'ongoing' || newStatus === 'active') {
    updates.startedAt = serverTimestamp();
  } else if (newStatus === 'ended') {
    updates.endedAt = serverTimestamp();
  }
  await updateDoc(meetingRef, updates).catch(() => {});

  if (classroomId) {
    await updateDoc(doc(db, 'classrooms', classroomId, 'meetings', meetingId), updates).catch(() => {});
  }
}

/**
 * Records a participant joining a meeting for attendance
 */
export async function recordMeetingJoin(meetingId, userProfile) {
  if (!meetingId || !userProfile) return;
  const db = getFirestore();
  const meetingRef = doc(db, 'meetings', meetingId);
  const snap = await getDoc(meetingRef);
  if (!snap.exists()) return;

  const data = snap.data();
  const participants = data.participants || [];
  const existing = participants.find(p => p.uid === userProfile.uid);

  if (!existing) {
    participants.push({
      uid: userProfile.uid,
      name: userProfile.displayName || 'Participant',
      role: userProfile.role || 'student',
      joinedAt: new Date().toISOString()
    });
    await updateDoc(meetingRef, {
      participants: participants,
      participantCount: participants.length
    });
  }
}

/**
 * Generates and downloads a CSV Attendance Report for a past meeting
 */
export function exportAttendanceCSV(meeting) {
  if (!meeting) return;

  const title = meeting.title || 'Live Class Session';
  const classroom = meeting.classroomName || 'Classroom';
  const dateStr = meeting.createdAt
    ? new Date(meeting.createdAt.toMillis ? meeting.createdAt.toMillis() : meeting.createdAt).toLocaleDateString()
    : new Date().toLocaleDateString();

  const participants = meeting.participants || [];

  let csvContent = `Meeting Title,${title}\n`;
  csvContent += `Classroom,${classroom}\n`;
  csvContent += `Date,${dateStr}\n`;
  csvContent += `Total Attendees,${participants.length}\n\n`;
  csvContent += `Student Name,Role,Joined At Status\n`;

  if (participants.length === 0) {
    csvContent += `No attendance records recorded.,,\n`;
  } else {
    participants.forEach(p => {
      const timeStr = p.joinedAt ? new Date(p.joinedAt).toLocaleTimeString() : 'Joined';
      csvContent += `"${p.name}","${p.role}","${timeStr}"\n`;
    });
  }

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `Attendance_Report_${(title).replace(/[^a-zA-Z0-9]/g, '_')}_${dateStr.replace(/[^a-zA-Z0-9]/g, '-')}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

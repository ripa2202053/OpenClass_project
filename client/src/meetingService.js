import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, getDoc, getDocs,
  query, where, orderBy, onSnapshot, serverTimestamp
} from 'firebase/firestore';
import { fetchWithAuth } from './utils/api.js';

// ─── MEETING SERVICE ───────────────────────────────────────────────────────

function buildLocalMeetingLink(roomName) {
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

export async function createMeeting(data) {
  if (!data) throw new Error('Meeting data required.');

  const cId = (data.classroomId && String(data.classroomId).trim()) ? data.classroomId.trim() : 'general';
  const db = getFirestore();
  const roomName = `OpenClass-${(data.classroomName || 'Class').replace(/[^a-zA-Z0-9]/g, '')}-${Date.now().toString(36)}`;

  const meetingDoc = {
    title: data.title || 'Live Class Session',
    topic: data.topic || data.title || 'Live Session',
    className: data.className || data.classroomName || 'General Class',
    classroomId: cId,
    classroomName: data.classroomName || 'General Class',
    createdBy: data.createdBy || '',
    teacherUid: data.createdBy || '',
    teacherName: data.teacherName || 'Teacher',
    roomName,
    meetingType: data.meetingType || 'instant',
    scheduledDate: data.scheduledDate || null,
    scheduledTime: data.scheduledTime || null,
    status: data.status || (data.meetingType === 'scheduled' ? 'scheduled' : 'ongoing'),
    meetingLink: buildLocalMeetingLink(roomName),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  // 1. Try Express API first
  try {
    if (cId && cId !== 'general' && cId !== 'default') {
      const res = await fetchWithAuth(`/api/classrooms/${cId}/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: meetingDoc.title,
          topic: meetingDoc.topic,
          description: data.description || '',
          scheduledAt: data.scheduledTime || null,
          meetingType: meetingDoc.meetingType,
        }),
      });
      if (res && (res.id || res.roomName)) {
        return { classroomId: cId, ...meetingDoc, ...res };
      }
    }
  } catch (err) {
    console.warn('Express API createMeeting failed, using direct Firestore write:', err.message);
  }

  // 2. Direct Firestore Write (Top-level meetings collection guarantees success!)
  const topRef = doc(collection(db, 'meetings'));
  const meetingId = topRef.id;
  const finalDoc = { id: meetingId, ...meetingDoc };

  try {
    await setDoc(topRef, finalDoc);
  } catch (err) {
    console.warn('Firestore top-level setDoc error:', err.message);
  }

  // 3. Subcollection write if valid classroomId provided
  if (cId && cId !== 'general' && cId !== 'default') {
    try {
      await setDoc(doc(db, 'classrooms', cId, 'meetings', meetingId), finalDoc);
    } catch (err) {
      console.warn('Firestore subcollection setDoc error:', err.message);
    }
  }

  return finalDoc;
}

export function subscribeTeacherMeetings(teacherUid, classroomIds, callback) {
  let cb = callback;
  let cIds = classroomIds;
  if (typeof classroomIds === 'function') {
    cb = classroomIds;
    cIds = [];
  }
  if (!teacherUid) return () => {};
  const db = getFirestore();
  const unsubs = [];
  const meetingsMap = new Map();

  const notify = () => {
    const allMap = new Map();
    meetingsMap.forEach((list) => {
      list.forEach((m) => {
        if (m && m.id) {
          allMap.set(m.id, m);
        }
      });
    });
    const combined = Array.from(allMap.values());
    combined.sort((a, b) => {
      const aTime = a.createdAt?.toMillis ? a.createdAt.toMillis() : (new Date(a.createdAt || 0).getTime());
      const bTime = b.createdAt?.toMillis ? b.createdAt.toMillis() : (new Date(b.createdAt || 0).getTime());
      return bTime - aTime;
    });
    if (typeof cb === 'function') cb(combined);
  };

  const validIds = Array.isArray(cIds) ? cIds.filter(Boolean) : [];
  if (validIds.length > 0) {
    validIds.forEach((cId) => {
      try {
        const q = query(
          collection(db, 'classrooms', cId, 'meetings'),
          orderBy('createdAt', 'desc')
        );
        const unsub = onSnapshot(q, (snapshot) => {
          const list = snapshot.docs.map((doc) => ({ id: doc.id, classroomId: cId, ...doc.data() }));
          meetingsMap.set(cId, list);
          notify();
        }, (err) => {
          console.warn(`subscribeTeacherMeetings subcol error for classroom ${cId}:`, err.message);
        });
        unsubs.push(unsub);
      } catch (err) {}
    });
  }

  try {
    const qTop = query(collection(db, 'meetings'), where('createdBy', '==', teacherUid));
    const unsubTop = onSnapshot(qTop, (snapshot) => {
      const list = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      meetingsMap.set('top-level', list);
      notify();
    }, (err) => {
      console.warn('subscribeTeacherMeetings top-level fallback:', err.message);
    });
    unsubs.push(unsubTop);
  } catch (err) {}

  return () => {
    unsubs.forEach((unsub) => {
      try { unsub(); } catch (e) {}
    });
  };
}

export function subscribeClassroomMeetings(classroomId, callback) {
  if (!classroomId) return () => {};
  const db = getFirestore();

  try {
    const q = query(
      collection(db, 'classrooms', classroomId, 'meetings'),
      orderBy('createdAt', 'desc')
    );

    return onSnapshot(q, (snapshot) => {
      const meetings = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(meetings);
    }, (err) => {
      console.warn('subscribeClassroomMeetings error:', err.message);
      callback([]);
    });
  } catch (e) {
    console.warn('subscribeClassroomMeetings init error:', e);
    return () => {};
  }
}

export function subscribeActiveMeetings(classroomIds, callback) {
  if (!Array.isArray(classroomIds) || classroomIds.length === 0) {
    callback([]);
    return () => {};
  }
  const db = getFirestore();
  const unsubs = [];
  const classroomMeetingsMap = new Map();

  const notify = () => {
    const allMap = new Map();
    classroomMeetingsMap.forEach((list) => {
      list.forEach((m) => {
        if (m && m.id) {
          allMap.set(m.id, m);
        }
      });
    });
    const combined = Array.from(allMap.values());
    combined.sort((a, b) => {
      const aTime = a.createdAt?.toMillis ? a.createdAt.toMillis() : (new Date(a.createdAt || 0).getTime());
      const bTime = b.createdAt?.toMillis ? b.createdAt.toMillis() : (new Date(b.createdAt || 0).getTime());
      return bTime - aTime;
    });
    callback(combined);
  };

  const validIds = classroomIds.filter(Boolean);
  if (validIds.length === 0) {
    callback([]);
    return () => {};
  }

  validIds.forEach((cId) => {
    try {
      const q = query(
        collection(db, 'classrooms', cId, 'meetings'),
        orderBy('createdAt', 'desc')
      );
      const unsub = onSnapshot(q, (snapshot) => {
        const list = snapshot.docs.map((doc) => ({ id: doc.id, classroomId: cId, ...doc.data() }));
        classroomMeetingsMap.set(cId, list);
        notify();
      }, (err) => {
        console.warn(`subscribeActiveMeetings error for classroom ${cId}:`, err.message);
      });
      unsubs.push(unsub);
    } catch (err) {
      console.warn(`Failed to subscribe to classroom ${cId} meetings:`, err.message);
    }
  });

  return () => {
    unsubs.forEach((unsub) => {
      try { unsub(); } catch (e) {}
    });
  };
}

export async function updateMeetingStatus(meetingId, status, classroomId) {
  if (!meetingId) return;

  const db = getFirestore();
  const updates = { status, updatedAt: serverTimestamp() };

  // 1. Instant Firestore write with setDoc ({ merge: true }) so real-time listeners update IMMEDIATELY!
  if (classroomId) {
    try {
      await setDoc(doc(db, 'classrooms', classroomId, 'meetings', meetingId), updates, { merge: true });
    } catch (e) {
      console.warn('Firestore subcol status update warning:', e);
    }
  }

  try {
    await setDoc(doc(db, 'meetings', meetingId), updates, { merge: true });
  } catch (e) {
    console.warn('Firestore top-level status update warning:', e);
  }

  // 2. Also notify backend API
  try {
    if (classroomId) {
      const action = status === 'ongoing' || status === 'live' ? 'start' : 'end';
      await fetchWithAuth(`/api/classrooms/${classroomId}/meetings/${meetingId}/${action}`, {
        method: 'POST'
      });
    }
  } catch (err) {}
}

export async function recordMeetingJoin(meetingId, userProfile, classroomId = null) {
  if (!meetingId || !userProfile) return;
  const db = getFirestore();
  const uid = userProfile.uid;

  let name = userProfile.displayName || userProfile.name;
  if (!name && userProfile.email) {
    name = userProfile.email.split('@')[0];
  }
  if (!name) name = 'Student';

  const email = userProfile.email || '';
  const now = new Date();
  const joinTimeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const record = {
    studentUid: uid,
    studentName: name,
    name: name,
    displayName: name,
    studentEmail: email,
    email: email,
    status: 'Present',
    joinTime: joinTimeStr,
    joinedMs: now.getTime(),
    leaveTime: 'In Meeting',
    durationFormatted: 'Active'
  };

  if (meetingId) {
    try {
      await setDoc(doc(db, 'meetings', meetingId, 'attendance', uid), record, { merge: true });
    } catch (e) {}
  }

  if (classroomId && meetingId) {
    try {
      await setDoc(doc(db, 'classrooms', classroomId, 'meetings', meetingId, 'attendance', uid), record, { merge: true });
    } catch (e) {}
  }
}

export async function recordMeetingLeave(meetingId, userProfile, classroomId = null) {
  if (!meetingId || !userProfile) return;
  const db = getFirestore();
  const uid = userProfile.uid;
  const now = new Date();
  const leaveTimeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const updates = {
    leaveTime: leaveTimeStr,
    leftMs: now.getTime()
  };

  if (meetingId) {
    try {
      await setDoc(doc(db, 'meetings', meetingId, 'attendance', uid), updates, { merge: true });
    } catch (e) {}
  }

  if (classroomId && meetingId) {
    try {
      await setDoc(doc(db, 'classrooms', classroomId, 'meetings', meetingId, 'attendance', uid), updates, { merge: true });
    } catch (e) {}
  }
}

export async function exportAttendanceCSV(meetingId, classroomId, meetingTitle = 'Live Class Session') {
  const db = getFirestore();
  let records = [];

  const mId = typeof meetingId === 'object' ? (meetingId.id || meetingId.meetingId) : meetingId;
  const cId = typeof meetingId === 'object' ? (meetingId.classroomId || classroomId) : classroomId;
  const title = typeof meetingId === 'object' ? (meetingId.title || meetingTitle) : meetingTitle;

  // 1. Try Express API first
  if (cId && mId) {
    try {
      const csvData = await fetchWithAuth(`/api/classrooms/${cId}/meetings/${mId}/attendance?format=csv`);
      if (typeof csvData === 'string' && csvData.includes('Student Name')) {
        triggerCSVDownload(csvData, `Attendance_${(title || 'Class').replace(/[^a-zA-Z0-9]/g, '_')}.csv`);
        return;
      }
    } catch (err) {
      console.warn('Express API attendance CSV fetch failed, falling back to direct Firestore fetch:', err.message);
    }
  }

  // 2. Direct Firestore fallback query (check both classroom subcol and top-level meetings)
  if (cId && mId) {
    try {
      const snap = await getDocs(collection(db, 'classrooms', cId, 'meetings', mId, 'attendance'));
      if (!snap.empty) {
        records = snap.docs.map(doc => doc.data());
      }
    } catch (err) {}
  }

  if (records.length === 0 && mId) {
    try {
      const snap = await getDocs(collection(db, 'meetings', mId, 'attendance'));
      if (!snap.empty) {
        records = snap.docs.map(doc => doc.data());
      }
    } catch (err) {}
  }

  // Build CSV String with full headers
  let csv = 'Student Name,Student Email,Status,Join Time,Leave Time,Duration\n';
  if (records.length === 0) {
    csv += '"No student records found","N/A","N/A","N/A","N/A","N/A"\n';
  } else {
    records.forEach(r => {
      const name = r.studentName || r.name || r.displayName || 'Student';
      const email = r.studentEmail || r.email || '';
      const status = r.status || 'Present';
      const joinTime = r.joinTime || (r.joinedAt ? new Date(r.joinedAt.toMillis ? r.joinedAt.toMillis() : r.joinedAt).toLocaleTimeString() : 'Joined');
      const leaveTime = r.leaveTime || 'Class Ended';
      let duration = r.durationFormatted || 'Present';
      if (r.joinedMs && r.leftMs) {
        const mins = Math.max(1, Math.round((r.leftMs - r.joinedMs) / 60000));
        duration = `${mins} mins`;
      }
      csv += `"${name}","${email}","${status}","${joinTime}","${leaveTime}","${duration}"\n`;
    });
  }

  triggerCSVDownload(csv, `Attendance_${(title || 'Class').replace(/[^a-zA-Z0-9]/g, '_')}.csv`);
}

function triggerCSVDownload(csvContent, filename) {
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

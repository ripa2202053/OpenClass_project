import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';
import { emitTeacherEvent } from '../utils/classroomEvents.js';

const router = express.Router({ mergeParams: true });
const MEETING_BASE_URL = 'https://meet.jit.si/OpenClass';

function generateRoomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let name = '';
  for (let i = 0; i < 12; i++) {
    name += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return name;
}

/**
 * Checks whether the user is the classroom owner or an approved member.
 */
async function checkClassroomAccess(db, classId, userUid) {
  if (!classId || !userUid) return { isOwner: false, isMember: false, classroomData: null };
  const classRef = db.collection('classrooms').doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists) return { isOwner: false, isMember: false, classroomData: null };

  const cData = classSnap.data();
  if (cData.isActive === false || cData.isDeleted === true) {
    return { isOwner: false, isMember: false, classroomData: null };
  }

  const isOwner = cData.createdBy === userUid || cData.teacherId === userUid || cData.teacherUid === userUid || cData.ownerId === userUid;
  let isMember = isOwner;

  if (!isMember) {
    if (Array.isArray(cData.enrolledStudents) && cData.enrolledStudents.includes(userUid)) {
      isMember = true;
    } else {
      const memberSnap = await classRef.collection('members').doc(userUid).get();
      if (memberSnap.exists && memberSnap.data().approved !== false) {
        isMember = true;
      }
    }
  }

  return { isOwner, isMember, classroomData: cData };
}

import { safeServerQuery, isQuotaExceededError } from '../utils/quotaGuard.js';

// GET /api/classrooms/:classId/meetings - List meetings for classroom
router.get('/', verifyAuthToken, async (req, res) => {
  const { classId } = req.params;
  const user = req.user;
  const cacheKey = `server_meetings_${classId}_${user.uid}`;

  try {
    const meetings = await safeServerQuery(cacheKey, async () => {
      const db = getFirestore();

      const access = await checkClassroomAccess(db, classId, user.uid);
      if (!access.classroomData || (!access.isOwner && !access.isMember)) {
        return null;
      }

      const snapshot = await db.collection('classrooms')
        .doc(classId)
        .collection('meetings')
        .get();

      return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => {
          const tA = a.createdAt?.seconds || (a.createdAt ? new Date(a.createdAt).getTime() : 0);
          const tB = b.createdAt?.seconds || (b.createdAt ? new Date(b.createdAt).getTime() : 0);
          return tB - tA;
        });
    }, [], 30000);

    if (meetings === null) {
      return res.status(403).json({ error: 'Permission denied: You are not authorized to view meetings for this classroom.' });
    }

    return res.json(meetings);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      console.warn('[Meetings Route] Firestore RESOURCE_EXHAUSTED. Returning empty meetings list.');
      return res.json([]);
    }
    console.error('Error fetching meetings:', error);
    return res.status(500).json({ error: 'Failed to fetch meetings', details: error.message });
  }
});

// GET /api/classrooms/:classId/meetings/:id - Fetch single meeting & check early join permissions
router.get('/:id', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || (!access.isOwner && !access.isMember)) {
      return res.status(403).json({ error: 'Permission denied: You are not authorized to access meetings for this classroom.' });
    }

    const snap = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }

    const meetingData = snap.data();

    // Block early join for enrolled students when status is 'scheduled'
    if (!access.isOwner && meetingData.status === 'scheduled') {
      return res.status(403).json({ error: 'Permission denied: This live class has not been started by the teacher yet.' });
    }

    if (meetingData.status === 'ended' || meetingData.status === 'cancelled') {
      return res.status(410).json({ error: 'This live class has already ended.' });
    }

    return res.json({ id: meetingId, ...meetingData });
  } catch (error) {
    console.error('Error fetching meeting:', error);
    return res.status(500).json({ error: 'Failed to fetch meeting', details: error.message });
  }
});

// POST /api/classrooms/:classId/meetings - Create / Schedule Live Class (Teacher owner only)
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { title, description, scheduledAt, meetingType } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can create live classes.' });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Meeting title is required.' });
    }

    const roomName = `OpenClass-${(access.classroomData.classroomName || 'Class').replace(/[^a-zA-Z0-9]/g, '')}-${generateRoomName()}`;
    const meetingLink = `${MEETING_BASE_URL}_${roomName}`;
    const now = FieldValue.serverTimestamp();
    const isInstant = meetingType === 'instant';

    const meetingData = {
      title: title.trim(),
      description: description ? description.trim() : '',
      roomName,
      meetingLink,
      createdBy: user.uid,
      teacherUid: user.uid,
      teacherId: user.uid,
      ownerId: user.uid,
      createdByName: user.name || user.displayName || user.email || 'Teacher',
      teacherName: user.name || user.displayName || user.email || 'Teacher',
      createdAt: now,
      scheduledAt: scheduledAt || null,
      scheduledTime: scheduledAt || null,
      startedAt: isInstant ? now : null,
      endedAt: null,
      status: isInstant ? 'ongoing' : 'scheduled',
      classroomId: classId,
      classroomName: access.classroomData.classroomName || 'Classroom',
      participants: [],
      participantCount: isInstant ? 1 : 0,
    };

    const docRef = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .add(meetingData);

    const meetingId = docRef.id;

    // Top-level meetings collection for global listener sync
    await db.collection('meetings').doc(meetingId).set({
      id: meetingId,
      ...meetingData,
    });

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'meeting_scheduled',
      description: `Live class created: ${title.trim()}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: now,
    });

    // Dual-layer event: course stream card + per-student notifications
    // (replaces the old top-level `notifications` fan-out; students now read
    // their own `users/{uid}/notifications` sub-collection — full data isolation)
    const className = access.classroomData.classroomName || 'Classroom';
    const teacherName = meetingData.teacherName || 'Teacher';
    try {
      await emitTeacherEvent(classId, access.classroomData, {
        type: 'meeting',
        title: 'New Live Class Scheduled',
        message: `${teacherName} scheduled a new live class "${meetingData.title}" in ${className}`,
        teacherName,
        teacherId: user.uid,
        itemId: meetingId,
        itemType: meetingType || 'scheduled',
        link: `/classroom/${classId}`,
        metadata: {
          title: meetingData.title,
          scheduledAt: scheduledAt || null,
          status: meetingData.status,
          meetingLink: meetingData.meetingLink,
          roomName: meetingData.roomName,
        },
      });
    } catch (err) {
      console.warn('[Meetings Route] Stream/notification emit failed (non-blocking):', err.message || err);
    }

    return res.status(201).json({ id: meetingId, ...meetingData });
  } catch (error) {
    console.error('Error creating meeting:', error);
    return res.status(500).json({ error: 'Failed to create meeting', details: error.message });
  }
});

// POST /api/classrooms/:classId/meetings/:id/start - Start meeting (Teacher owner only)
router.post('/:id/start', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can start live classes.' });
    }

    const meetingRef = db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId);
    const snap = await meetingRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }

    const updates = {
      status: 'ongoing',
      startedAt: FieldValue.serverTimestamp(),
    };

    await meetingRef.update(updates);
    try {
      await db.collection('meetings').doc(meetingId).update(updates);
    } catch (e) {}

    return res.json({ message: 'Meeting started', id: meetingId, status: 'ongoing' });
  } catch (error) {
    console.error('Error starting meeting:', error);
    return res.status(500).json({ error: 'Failed to start meeting', details: error.message });
  }
});

// POST /api/classrooms/:classId/meetings/:id/end - End meeting (Teacher owner only)
router.post('/:id/end', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can end live classes.' });
    }

    const meetingRef = db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId);
    const snap = await meetingRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }

    const updates = {
      status: 'ended',
      endedAt: FieldValue.serverTimestamp(),
    };

    await meetingRef.update(updates);
    try {
      await db.collection('meetings').doc(meetingId).update(updates);
    } catch (e) {}

    return res.json({ message: 'Meeting ended', id: meetingId, status: 'ended' });
  } catch (error) {
    console.error('Error ending meeting:', error);
    return res.status(500).json({ error: 'Failed to end meeting', details: error.message });
  }
});

// DELETE /api/classrooms/:classId/meetings/:id - Cancel/delete meeting (Teacher owner only)
router.delete('/:id', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can delete live classes.' });
    }

    await db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId).delete();
    try {
      await db.collection('meetings').doc(meetingId).delete();
    } catch (e) {}

    return res.json({ message: 'Meeting deleted successfully', id: meetingId });
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return res.status(500).json({ error: 'Failed to delete meeting', details: error.message });
  }
});

// GET /api/classrooms/:classId/meetings/:id/attendance - View & Export Attendance (Teacher owner only)
router.get('/:id/attendance', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const { format } = req.query;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can view or export attendance.' });
    }

    // 1. Fetch classroom enrolled students and members
    const membersSnap = await db.collection('classrooms').doc(classId).collection('members').get();
    const approvedStudentsMap = new Map();

    if (Array.isArray(access.classroomData.enrolledStudents)) {
      access.classroomData.enrolledStudents.forEach(uid => {
        approvedStudentsMap.set(uid, { uid, name: 'Student', email: '' });
      });
    }

    membersSnap.docs.forEach(doc => {
      const data = doc.data();
      if (data.uid && data.uid !== access.classroomData.createdBy && data.approved !== false) {
        approvedStudentsMap.set(data.uid, {
          uid: data.uid,
          name: data.displayName || data.name || data.email || 'Student',
          email: data.email || '',
        });
      }
    });

    // 2. Fetch recorded attendance subcollection
    const attSnap = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('attendance')
      .get();

    const attendanceRecordsMap = new Map();
    attSnap.docs.forEach(doc => {
      attendanceRecordsMap.set(doc.id, doc.data());
    });

    // 3. Combine list into final attendance report
    const attendanceList = [];
    approvedStudentsMap.forEach((student, uid) => {
      const rec = attendanceRecordsMap.get(uid);
      if (rec && rec.status === 'Present') {
        const joinTimeStr = rec.joinedAt ? new Date(rec.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--';
        const leaveTimeStr = rec.leftAt ? new Date(rec.leftAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Still in class';
        const dur = rec.totalDuration || 0;
        attendanceList.push({
          studentUid: uid,
          studentName: rec.studentName || student.name,
          studentEmail: rec.studentEmail || student.email,
          joinTime: joinTimeStr,
          leaveTime: leaveTimeStr,
          joinedAt: rec.joinedAt,
          leftAt: rec.leftAt,
          totalDuration: dur,
          durationFormatted: `${dur} min`,
          status: 'Present',
        });
      } else {
        attendanceList.push({
          studentUid: uid,
          studentName: student.name,
          studentEmail: student.email,
          joinTime: '--',
          leaveTime: '--',
          joinedAt: null,
          leftAt: null,
          totalDuration: 0,
          durationFormatted: '0 min',
          status: 'Absent',
        });
      }
    });

    // 4. Return CSV export or JSON response
    if (format === 'csv') {
      let csv = 'Student Name,Email,Join Time,Leave Time,Total Duration,Status\n';
      attendanceList.forEach(row => {
        const name = `"${(row.studentName || '').replace(/"/g, '""')}"`;
        const email = `"${(row.studentEmail || '').replace(/"/g, '""')}"`;
        csv += `${name},${email},${row.joinTime},${row.leaveTime},${row.durationFormatted},${row.status}\n`;
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="attendance_${classId}_${meetingId}.csv"`);
      return res.send(csv);
    }

    return res.json({ meetingId, classroomId: classId, count: attendanceList.length, records: attendanceList });
  } catch (error) {
    console.error('Error fetching attendance:', error);
    return res.status(500).json({ error: 'Failed to fetch attendance', details: error.message });
  }
});

// GET /api/classrooms/:classId/meetings/:id/messages - Persistent Class Chat / Q&A History
router.get('/:id/messages', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || (!access.isOwner && !access.isMember)) {
      return res.status(403).json({ error: 'Permission denied: You are not authorized to view messages for this classroom.' });
    }

    const messagesSnap = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('messages')
      .get();

    const messages = messagesSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

    return res.json(messages);
  } catch (error) {
    console.error('Error fetching meeting messages:', error);
    return res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
  }
});

// DELETE /api/classrooms/:classId/meetings/:id/messages/:messageId - Soft delete chat message (Teacher owner only)
router.delete('/:id/messages/:messageId', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId, messageId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can delete messages.' });
    }

    await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('messages')
      .doc(messageId)
      .update({ isDeleted: true });

    return res.json({ message: 'Message deleted successfully', messageId });
  } catch (error) {
    console.error('Error deleting message:', error);
    return res.status(500).json({ error: 'Failed to delete message', details: error.message });
  }
});

// PUT /api/classrooms/:classId/meetings/:id - Update scheduled meeting (Teacher owner only)
router.put('/:id', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const { title, description, scheduledAt, durationMins } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can edit live classes.' });
    }

    if (scheduledAt && new Date(scheduledAt).getTime() < Date.now() - 60000) {
      return res.status(400).json({ error: 'Cannot schedule a live class in the past.' });
    }

    const updates = {
      ...(title ? { title: title.trim() } : {}),
      ...(description !== undefined ? { description: description.trim() } : {}),
      ...(scheduledAt ? { scheduledAt, scheduledTime: scheduledAt } : {}),
      ...(durationMins ? { durationMins: Number(durationMins) } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId).update(updates);
    try {
      await db.collection('meetings').doc(meetingId).update(updates);
    } catch (e) {}

    return res.json({ message: 'Meeting updated successfully', id: meetingId, ...updates });
  } catch (error) {
    console.error('Error updating meeting:', error);
    return res.status(500).json({ error: 'Failed to update meeting', details: error.message });
  }
});

// GET /api/classrooms/:classId/meetings/:id/notes - Get Notes (Classroom Members or Owner)
router.get('/:id/notes', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || (!access.isOwner && !access.isMember)) {
      return res.status(403).json({ error: 'Permission denied: You are not authorized to view notes for this classroom.' });
    }

    const snap = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('notes')
      .get();

    const notes = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json(notes);
  } catch (error) {
    console.error('Error fetching notes:', error);
    return res.status(500).json({ error: 'Failed to fetch notes', details: error.message });
  }
});

// POST /api/classrooms/:classId/meetings/:id/notes - Add Note (Teacher owner only)
router.post('/:id/notes', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const { title, content, pinned } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can create notes.' });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Note title is required.' });
    }

    const noteObj = {
      title: title.trim(),
      content: content ? content.trim() : '',
      pinned: Boolean(pinned),
      createdBy: user.uid,
      createdByName: user.name || user.displayName || user.email || 'Teacher',
      createdAt: new Date().toISOString(),
    };

    const docRef = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('notes')
      .add(noteObj);

    return res.status(201).json({ id: docRef.id, ...noteObj });
  } catch (error) {
    console.error('Error creating note:', error);
    return res.status(500).json({ error: 'Failed to create note', details: error.message });
  }
});

// GET /api/classrooms/:classId/meetings/:id/resources - Get Resources (Classroom Members or Owner)
router.get('/:id/resources', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || (!access.isOwner && !access.isMember)) {
      return res.status(403).json({ error: 'Permission denied: You are not authorized to view resources for this classroom.' });
    }

    const snap = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('resources')
      .get();

    const resources = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json(resources);
  } catch (error) {
    console.error('Error fetching resources:', error);
    return res.status(500).json({ error: 'Failed to fetch resources', details: error.message });
  }
});

// POST /api/classrooms/:classId/meetings/:id/resources - Add Resource (Teacher owner only)
router.post('/:id/resources', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const { title, description, url, fileType } = req.body;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can add resources.' });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Resource title is required.' });
    }

    const resourceObj = {
      title: title.trim(),
      description: description ? description.trim() : '',
      url: url ? url.trim() : '',
      fileType: fileType || 'link',
      createdBy: user.uid,
      createdByName: user.name || user.displayName || user.email || 'Teacher',
      createdAt: new Date().toISOString(),
    };

    const docRef = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('resources')
      .add(resourceObj);

    return res.status(201).json({ id: docRef.id, ...resourceObj });
  } catch (error) {
    console.error('Error creating resource:', error);
    return res.status(500).json({ error: 'Failed to add resource', details: error.message });
  }
});

// GET /api/classrooms/:classId/meetings/:id/analytics - Teacher Live Class Analytics (Teacher owner only)
router.get('/:id/analytics', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const user = req.user;
    const db = getFirestore();

    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.classroomData || !access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can view full analytics.' });
    }

    const meetingSnap = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .get();

    const meetingData = meetingSnap.exists ? meetingSnap.data() : {};

    // Enrolled students count
    const enrolledStudents = access.classroomData.enrolledStudents || [];
    const totalStudents = enrolledStudents.length;

    // Attendance data
    const attSnap = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('attendance')
      .get();

    const attDocs = attSnap.docs.map(d => d.data());
    const presentCount = attDocs.filter(a => a.status === 'Present').length;
    const absentCount = Math.max(0, totalStudents - presentCount);
    const attendanceRate = totalStudents > 0 ? Math.round((presentCount / totalStudents) * 100 * 10) / 10 : 0;

    // Durations
    const totalDurationsSum = attDocs.reduce((acc, a) => acc + (a.totalDuration || 0), 0);
    const avgDuration = presentCount > 0 ? Math.round(totalDurationsSum / presentCount) : 0;

    // Messages & Q&A
    const msgSnap = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('messages')
      .get();

    const msgs = msgSnap.docs.map(d => d.data());
    const chatMessages = msgs.length;
    const questionsAsked = msgs.filter(m => m.isQuestion || m.type === 'question').length;

    // Polls
    const pollSnap = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .doc(meetingId)
      .collection('polls')
      .get();

    const pollsConducted = pollSnap.size;

    return res.json({
      meetingId,
      classroomId: classId,
      title: meetingData.title || 'Live Class',
      status: meetingData.status || 'ended',
      totalStudents,
      present: presentCount,
      absent: absentCount,
      attendanceRate,
      avgDuration,
      questionsAsked,
      chatMessages,
      pollsConducted,
      peakParticipants: meetingData.peakParticipants || presentCount,
      classDuration: meetingData.durationMins || 60,
    });
  } catch (error) {
    console.error('Error fetching meeting analytics:', error);
    return res.status(500).json({ error: 'Failed to fetch analytics', details: error.message });
  }
});

export default router;

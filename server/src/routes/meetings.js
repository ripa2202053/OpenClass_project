import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';
import { safeServerQuery } from '../utils/quotaGuard.js';

const router = express.Router({ mergeParams: true });

function buildLocalMeetingLink(roomName) {
  return `/?meeting=${encodeURIComponent(roomName)}`;
}

function generateRoomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let name = '';
  for (let i = 0; i < 12; i++) {
    name += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return name;
}

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
    if ((Array.isArray(cData.enrolledStudents) && cData.enrolledStudents.includes(userUid)) ||
        (Array.isArray(cData.students) && cData.students.includes(userUid)) ||
        (Array.isArray(cData.members) && cData.members.includes(userUid))) {
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

// GET /api/classrooms/:classId/meetings
router.get('/', verifyAuthToken, async (req, res) => {
  const { classId } = req.params;
  const user = req.user;
  const db = getFirestore();

  try {
    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.isOwner && !access.isMember) {
      return res.status(403).json({ error: 'Permission denied: Not a member of this classroom.' });
    }

    const meetingsSnap = await safeServerQuery(() =>
      db.collection('classrooms').doc(classId).collection('meetings').orderBy('createdAt', 'desc').get()
    );

    if (!meetingsSnap) return res.json([]);
    const meetings = meetingsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(meetings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch meetings', details: err.message });
  }
});

// POST /api/classrooms/:classId/meetings - Create meeting
router.post('/', verifyAuthToken, async (req, res) => {
  const { classId } = req.params;
  const { title, topic, description, scheduledAt, meetingType } = req.body;
  const user = req.user;
  const db = getFirestore();

  try {
    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can create meetings.' });
    }

    const roomName = `OpenClass-${(access.classroomData.classroomName || 'Class').replace(/[^a-zA-Z0-9]/g, '')}-${generateRoomName()}`;
    const meetingLink = buildLocalMeetingLink(roomName);
    const now = FieldValue.serverTimestamp();
    const isInstant = meetingType === 'instant';

    const meetingData = {
      title: (title || 'Live Class Session').trim(),
      topic: (topic || title || '').trim(),
      className: access.classroomData.classroomName || 'General Class',
      classroomId: classId,
      classroomName: access.classroomData.classroomName || 'General Class',
      description: (description || '').trim(),
      roomName,
      meetingLink,
      createdBy: user.uid,
      teacherUid: user.uid,
      teacherId: user.uid,
      teacherName: user.name || user.email || 'Teacher',
      meetingType: isInstant ? 'instant' : 'scheduled',
      scheduledTime: scheduledAt || null,
      status: isInstant ? 'ongoing' : 'scheduled',
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await db.collection('classrooms').doc(classId).collection('meetings').add(meetingData);
    await db.collection('meetings').doc(docRef.id).set({ id: docRef.id, ...meetingData });

    res.status(201).json({ id: docRef.id, ...meetingData });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create meeting', details: err.message });
  }
});

// POST /api/classrooms/:classId/meetings/:id/start
router.post('/:id/start', verifyAuthToken, async (req, res) => {
  const { classId, id } = req.params;
  const user = req.user;
  const db = getFirestore();

  try {
    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the teacher can start meetings.' });
    }

    const updates = { status: 'ongoing', updatedAt: FieldValue.serverTimestamp() };
    try {
      await db.collection('classrooms').doc(classId).collection('meetings').doc(id).set(updates, { merge: true });
    } catch (e) {}
    try {
      await db.collection('meetings').doc(id).set(updates, { merge: true });
    } catch (e) {}

    res.json({ ok: true, status: 'ongoing' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start meeting', details: err.message });
  }
});

// POST /api/classrooms/:classId/meetings/:id/end
router.post('/:id/end', verifyAuthToken, async (req, res) => {
  const { classId, id } = req.params;
  const user = req.user;
  const db = getFirestore();

  try {
    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the teacher can end meetings.' });
    }

    const updates = { status: 'ended', updatedAt: FieldValue.serverTimestamp() };
    try {
      await db.collection('classrooms').doc(classId).collection('meetings').doc(id).set(updates, { merge: true });
    } catch (e) {}
    try {
      await db.collection('meetings').doc(id).set(updates, { merge: true });
    } catch (e) {}

    // Broadcast meeting-ended socket event to all connected students
    try {
      const io = req.app.get('io');
      if (io) {
        const meetingSnap = await db.collection('meetings').doc(id).get();
        if (meetingSnap.exists) {
          const mData = meetingSnap.data();
          if (mData.roomName) {
            io.to(mData.roomName).emit('meeting-ended', { message: 'The teacher has ended this live class.' });
          }
        }
        io.to(id).emit('meeting-ended', { message: 'The teacher has ended this live class.' });
      }
    } catch (e) {
      console.warn('Socket emit meeting-ended warning:', e);
    }

    res.json({ ok: true, status: 'ended' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to end meeting', details: err.message });
  }
});

// GET /api/classrooms/:classId/meetings/:id/attendance - Teacher-only Attendance Report & CSV export
router.get('/:id/attendance', verifyAuthToken, async (req, res) => {
  const { classId, id } = req.params;
  const user = req.user;
  const db = getFirestore();

  try {
    const access = await checkClassroomAccess(db, classId, user.uid);
    if (!access.isOwner) {
      return res.status(403).json({ error: 'Access Denied: Attendance records are strictly restricted to the classroom teacher.' });
    }

    const attendanceSnap = await db.collection('classrooms').doc(classId).collection('meetings').doc(id).collection('attendance').get();
    let records = [];

    if (!attendanceSnap.empty) {
      records = attendanceSnap.docs.map(doc => {
        const d = doc.data();
        let duration = 'Present';
        if (d.joinedMs && d.leftMs) {
          const mins = Math.max(1, Math.round((d.leftMs - d.joinedMs) / 60000));
          duration = `${mins} mins`;
        } else if (d.durationFormatted) {
          duration = d.durationFormatted;
        }
        return {
          studentUid: d.studentUid || doc.id,
          studentName: d.studentName || d.name || 'Student',
          studentEmail: d.studentEmail || d.email || '',
          status: d.status || 'Present',
          joinTime: d.joinTime || 'Joined',
          leaveTime: d.leaveTime || 'Class Ended',
          durationFormatted: duration
        };
      });
    }

    if (req.query.format === 'csv') {
      let csv = 'Student Name,Student Email,Status,Join Time,Leave Time,Duration\n';
      records.forEach(r => {
        csv += `"${r.studentName}","${r.studentEmail}","${r.status}","${r.joinTime}","${r.leaveTime}","${r.durationFormatted}"\n`;
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=Attendance_${id}.csv`);
      return res.send(csv);
    }

    res.json({ ok: true, records });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance', details: err.message });
  }
});

export default router;

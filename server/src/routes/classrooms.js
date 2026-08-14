import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';
import { emitTeacherEvent } from '../utils/classroomEvents.js';

const router = express.Router();

function generateClassroomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// POST /api/classrooms - Create classroom (Google Classroom style)
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const { classroomName, description, section, subject, room, themeColor, coverImageUrl } = req.body;
    const user = req.user;

    if (!classroomName || !classroomName.trim()) {
      return res.status(400).json({ error: 'Classroom name cannot be empty.' });
    }

    const db = getFirestore();
    const code = generateClassroomCode();

    const classroom = {
      classroomName: classroomName.trim(),
      classroomCode: code,
      description: description ? description.trim() : '',
      section: section ? section.trim() : '',
      subject: subject ? subject.trim() : '',
      room: room ? room.trim() : '',
      themeColor: themeColor || 'blue',
      coverImageUrl: coverImageUrl || '',
      createdBy: user.uid,
      teacherId: user.uid,
      teacherUid: user.uid,
      ownerId: user.uid,
      teacherName: user.name || user.displayName || user.email || 'Teacher',
      teacherPhoto: user.picture || user.photoURL || '',
      createdAt: FieldValue.serverTimestamp(),
      createdDate: new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
      memberCount: 1,
      isActive: true,
      isArchived: false,
    };

    const docRef = await db.collection('classrooms').add(classroom);

    // Add creator as member
    await db.collection('classrooms').doc(docRef.id).collection('members').doc(user.uid).set({
      uid: user.uid,
      displayName: user.name || user.displayName || user.email || 'Teacher',
      email: user.email || '',
      photoURL: user.picture || user.photoURL || '',
      role: 'teacher',
      joinedAt: FieldValue.serverTimestamp(),
      approved: true,
      approvedBy: user.uid,
      approvedAt: FieldValue.serverTimestamp(),
    });

    // Add activity log
    await db.collection('classrooms').doc(docRef.id).collection('activity').add({
      type: 'classroom_created',
      description: 'Classroom created',
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.status(201).json({ id: docRef.id, ...classroom, classroomCode: code });
  } catch (error) {
    console.error('Error creating classroom:', error);
    return res.status(500).json({ error: 'Failed to create classroom', details: error.message });
  }
});

import { safeServerQuery, isQuotaExceededError } from '../utils/quotaGuard.js';

// GET /api/classrooms - Fetch joined or owned classes for logged-in user
router.get('/', verifyAuthToken, async (req, res) => {
  const uid = req.user.uid;
  const isTeacher = (req.user.role || '').toLowerCase() === 'teacher' || (req.user.role || '').toLowerCase() === 'admin';
  const cacheKey = `server_user_classrooms_${uid}_${isTeacher}`;

  try {
    const classrooms = await safeServerQuery(cacheKey, async () => {
      const db = getFirestore();
      const list = [];
      const seenIds = new Set();

      if (isTeacher) {
        // Query at DB level specifically for classrooms created by this teacher
        const createdSnap = await db.collection('classrooms')
          .where('isActive', '==', true)
          .where('createdBy', '==', uid)
          .get();

        for (const doc of createdSnap.docs) {
          seenIds.add(doc.id);
          list.push({ id: doc.id, ...doc.data() });
        }

        // Also check fallback teacherId/teacherUid/ownerId fields at DB level
        const teacherIdSnap = await db.collection('classrooms')
          .where('isActive', '==', true)
          .where('teacherId', '==', uid)
          .get();

        for (const doc of teacherIdSnap.docs) {
          if (!seenIds.has(doc.id)) {
            seenIds.add(doc.id);
            list.push({ id: doc.id, ...doc.data() });
          }
        }
      } else {
        const createdSnap = await db.collection('classrooms')
          .where('isActive', '==', true)
          .get();

        for (const doc of createdSnap.docs) {
          const data = doc.data();
          let isMember = (
            data.createdBy === uid ||
            data.teacherId === uid ||
            (Array.isArray(data.members) && data.members.includes(uid)) ||
            (Array.isArray(data.enrolledStudents) && data.enrolledStudents.includes(uid))
          );

          if (!isMember) {
            try {
              const memberSnap = await db.collection('classrooms').doc(doc.id).collection('members').doc(uid).get();
              if (memberSnap.exists) isMember = true;
            } catch (e) {}
          }

          if (isMember) {
            seenIds.add(doc.id);
            list.push({ id: doc.id, ...data });
          }
        }
      }

      return list;
    }, [], 30000);

    return res.json(classrooms);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      console.warn('[Classrooms Route] Firestore RESOURCE_EXHAUSTED. Returning empty/cached classrooms list.');
      return res.json([]);
    }
    console.error('Error fetching classrooms:', error);
    return res.status(500).json({ error: 'Failed to fetch classrooms', details: error.message });
  }
});

// PUT /api/classrooms/:id - Update classroom details
router.put('/:id', verifyAuthToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { classroomName, description, section, subject, room, themeColor, coverImageUrl } = req.body;
    const user = req.user;

    const db = getFirestore();
    const classRef = db.collection('classrooms').doc(id);
    const snap = await classRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Classroom not found.' });
    }

    if (snap.data().createdBy !== user.uid) {
      return res.status(403).json({ error: 'Permission denied: Only the teacher/creator can edit this classroom.' });
    }

    const updates = {
      ...(classroomName ? { classroomName: classroomName.trim() } : {}),
      ...(description !== undefined ? { description: description.trim() } : {}),
      ...(section !== undefined ? { section: section.trim() } : {}),
      ...(subject !== undefined ? { subject: subject.trim() } : {}),
      ...(room !== undefined ? { room: room.trim() } : {}),
      ...(themeColor ? { themeColor } : {}),
      ...(coverImageUrl !== undefined ? { coverImageUrl } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await classRef.update(updates);

    return res.json({ id, message: 'Classroom updated successfully', ...updates });
  } catch (error) {
    console.error('Error updating classroom:', error);
    return res.status(500).json({ error: 'Failed to update classroom', details: error.message });
  }
});

// PUT /api/classrooms/:id/archive - Toggle archive status
router.put('/:id/archive', verifyAuthToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const db = getFirestore();
    const classRef = db.collection('classrooms').doc(id);
    const snap = await classRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Classroom not found.' });
    }

    if (snap.data().createdBy !== user.uid) {
      return res.status(403).json({ error: 'Permission denied.' });
    }

    const newStatus = !snap.data().isArchived;
    await classRef.update({
      isArchived: newStatus,
      isActive: !newStatus,
      updatedAt: FieldValue.serverTimestamp()
    });

    return res.json({ id, isArchived: newStatus, message: newStatus ? 'Classroom archived' : 'Classroom unarchived' });
  } catch (error) {
    console.error('Error archiving classroom:', error);
    return res.status(500).json({ error: 'Failed to archive classroom', details: error.message });
  }
});

// DELETE /api/classrooms/:id - Soft-delete classroom
router.delete('/:id', verifyAuthToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const db = getFirestore();
    const classRef = db.collection('classrooms').doc(id);
    const snap = await classRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Classroom not found.' });
    }

    if (snap.data().createdBy !== user.uid) {
      return res.status(403).json({ error: 'Permission denied.' });
    }

    await classRef.update({
      isActive: false,
      isDeleted: true,
      updatedAt: FieldValue.serverTimestamp()
    });

    return res.json({ id, message: 'Classroom deleted successfully' });
  } catch (error) {
    console.error('Error deleting classroom:', error);
    return res.status(500).json({ error: 'Failed to delete classroom', details: error.message });
  }
});

// POST /api/classrooms/join - Request to join via classroom code (pending approval)
router.post('/join', verifyAuthToken, async (req, res) => {
  try {
    const { code } = req.body;
    const user = req.user;

    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Classroom code is required.' });
    }

    const db = getFirestore();
    const querySnap = await db.collection('classrooms')
      .where('classroomCode', '==', code.trim().toUpperCase())
      .where('isActive', '==', true)
      .get();

    if (querySnap.empty) {
      return res.status(404).json({ error: 'Invalid classroom code or classroom not found.' });
    }

    const classDoc = querySnap.docs[0];
    const classId = classDoc.id;
    const classRef = db.collection('classrooms').doc(classId);
    const classData = classDoc.data();

    // Check if already a member
    const memberRef = classRef.collection('members').doc(user.uid);
    const memberSnap = await memberRef.get();

    if (memberSnap.exists) {
      return res.status(400).json({ error: 'You are already a member of this classroom.', classId });
    }

    // Check if a request is already pending
    const joinReqRef = classRef.collection('joinRequests').doc(user.uid);
    const joinReqSnap = await joinReqRef.get();

    if (joinReqSnap.exists && joinReqSnap.data().status === 'pending') {
      return res.status(200).json({
        message: 'You already have a pending join request for this classroom.',
        status: 'pending',
        classId,
        classroomName: classData.classroomName,
      });
    }

    // Add a pending join request instead of enrolling immediately
    const requestedBy = {
      uid: user.uid,
      displayName: user.name || user.displayName || user.email || 'Student',
      email: user.email || '',
      photoURL: user.picture || user.photoURL || '',
      role: 'student',
    };

    await joinReqRef.set({
      ...requestedBy,
      requestedAt: FieldValue.serverTimestamp(),
      status: 'pending',
    });

    // Top-level collection makes the teacher's approvals tab a simple query on
    // teacherUid. The per-classroom subcollection mirrors it for classroom-detail
    // views that already subscribe to joinRequests.
    const resolvedTeacherUid = classData.ownerId || classData.teacherUid || classData.createdBy || classData.userId || classData.teacherId || '';
    console.log('[DEBUG Join Request] Class Owner UID:', classData.ownerId || classData.teacherUid, 'Current User:', user.uid);
    console.log('[Join API] Student joining class:', classId, 'Teacher:', resolvedTeacherUid);
    const requestId = `${classId}_${user.uid}`;
    const globalReqRef = db.collection('classroomRequests').doc(requestId);
    await globalReqRef.set({
      requestId,
      studentUid: user.uid,
      uid: user.uid,
      displayName: user.displayName || user.name || user.email || 'Student',
      studentName: user.displayName || user.name || user.email || 'Student',
      email: user.email || '',
      studentEmail: user.email || '',
      studentId: user.studentId || user.roll || '',
      department: user.department || '',
      photoURL: requestedBy.photoURL || '',
      role: 'student',
      classId,
      className: classData.classroomName || classData.courseName || 'Classroom',
      classroomId: classId,
      classroomName: classData.classroomName || classData.courseName || 'Classroom',
      classroomCode: classData.classroomCode || '',
      teacherUid: resolvedTeacherUid,
      ownerId: resolvedTeacherUid,
      teacherId: resolvedTeacherUid,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    // Notify the teacher (best-effort, non-blocking) so the bell badge updates.
    if (resolvedTeacherUid) {
      await db.collection('notifications').add({
        recipientId: resolvedTeacherUid,
        userId: resolvedTeacherUid,
        teacherUid: resolvedTeacherUid,
        classId,
        type: 'join_request',
        title: 'New Join Request',
        message: `${requestedBy.displayName} requested to join ${classData.classroomName || classData.courseName || 'your classroom'}`,
        body: `${requestedBy.displayName} requested to join ${classData.classroomName || classData.courseName || 'your classroom'}`,
        isRead: false,
        read: false,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }

    // Keep the classroom document arrays in sync
    await classRef.update({
      pendingRequests: FieldValue.arrayUnion(requestedBy),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Add activity log
    await classRef.collection('activity').add({
      type: 'join_requested',
      description: `${user.name || user.email || 'A student'} requested to join the classroom`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Student',
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      message: 'Join request sent to teacher for approval.',
      status: 'pending',
      classId,
      classroomName: classData.classroomName,
    });
  } catch (error) {
    console.error('Error joining classroom:', error);
    return res.status(500).json({ error: 'Failed to join classroom', details: error.message });
  }
});

// GET /api/classrooms/:id/requests - Fetch pending join requests (teacher only)
router.get('/:id/requests', verifyAuthToken, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const db = getFirestore();
    const classRef = db.collection('classrooms').doc(id);
    const snap = await classRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Classroom not found.' });
    }

    if (snap.data().createdBy !== user.uid) {
      return res.status(403).json({ error: 'Permission denied: Only the teacher can view join requests.' });
    }

    const reqSnap = await classRef.collection('joinRequests')
      .where('status', '==', 'pending')
      .get();

    const requests = reqSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const tA = a.requestedAt?.seconds || 0;
        const tB = b.requestedAt?.seconds || 0;
        return tB - tA;
      });
    return res.json({ requests, count: requests.length });
  } catch (error) {
    console.error('Error fetching join requests:', error);
    return res.status(500).json({ error: 'Failed to fetch join requests', details: error.message });
  }
});

// POST /api/classrooms/:id/requests/:userId/accept - Approve a join request
router.post('/:id/requests/:userId/accept', verifyAuthToken, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const user = req.user;

    const db = getFirestore();
    const classRef = db.collection('classrooms').doc(id);
    const classSnap = await classRef.get();

    if (!classSnap.exists) {
      return res.status(404).json({ error: 'Classroom not found.' });
    }

    if (classSnap.data().createdBy !== user.uid) {
      return res.status(403).json({ error: 'Permission denied: Only the teacher can approve join requests.' });
    }

    const joinReqRef = classRef.collection('joinRequests').doc(userId);
    const joinReqSnap = await joinReqRef.get();
    if (!joinReqSnap.exists) {
      return res.status(404).json({ error: 'No join request found for this student.' });
    }
    const reqData = joinReqSnap.data();

    // Enroll the student as an approved member
    await classRef.collection('members').doc(userId).set({
      uid: userId,
      displayName: reqData.displayName,
      email: reqData.email || '',
      photoURL: reqData.photoURL || '',
      role: (reqData.role || 'student').toLowerCase(),
      joinedAt: FieldValue.serverTimestamp(),
      approved: true,
      approvedBy: user.uid,
      approvedAt: FieldValue.serverTimestamp(),
    });

    // Remove the request
    await joinReqRef.delete();

    // Keep the top-level classroomRequests doc in sync so the teacher's
    // approvals tab (which queries teacherUid) reflects the approval live.
    try {
      await db.collection('classroomRequests').doc(`${id}_${userId}`).update({
        status: 'approved',
        approvedBy: user.uid,
        approvedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('Could not update top-level classroomRequests on accept:', e.message);
    }

    // Keep the classroom document arrays + counts in sync
    const pendingAfter = (classSnap.data().pendingRequests || [])
      .filter(r => (r.uid || r.userId) !== userId);

    await classRef.update({
      memberCount: FieldValue.increment(1),
      enrolledStudents: FieldValue.arrayUnion(userId),
      pendingRequests: pendingAfter,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Add activity log (include the student's roll number when present)
    const joinDisplayName = reqData.displayName || 'A student';
    const joinRoll = reqData.studentId || reqData.roll || '';
    const joinLogName = joinRoll ? `${joinDisplayName} (${joinRoll})` : joinDisplayName;
    await classRef.collection('activity').add({
      type: 'member_approved',
      description: `${joinLogName} joined the classroom`,
      userId,
      userName: joinDisplayName,
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Join request approved. Student enrolled.', userId, classroomId: id });
  } catch (error) {
    console.error('Error approving join request:', error);
    return res.status(500).json({ error: 'Failed to approve join request', details: error.message });
  }
});

// POST /api/classrooms/:id/requests/:userId/reject - Reject a join request
router.post('/:id/requests/:userId/reject', verifyAuthToken, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const user = req.user;

    const db = getFirestore();
    const classRef = db.collection('classrooms').doc(id);
    const classSnap = await classRef.get();

    if (!classSnap.exists) {
      return res.status(404).json({ error: 'Classroom not found.' });
    }

    if (classSnap.data().createdBy !== user.uid) {
      return res.status(403).json({ error: 'Permission denied: Only the teacher can reject join requests.' });
    }

    await classRef.collection('joinRequests').doc(userId).delete();

    // Keep the top-level classroomRequests doc in sync so the teacher's
    // approvals tab (which queries teacherUid) reflects the rejection live.
    try {
      await db.collection('classroomRequests').doc(`${id}_${userId}`).update({
        status: 'rejected',
        rejectedBy: user.uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('Could not update top-level classroomRequests on reject:', e.message);
    }

    const pendingAfter = (classSnap.data().pendingRequests || [])
      .filter(r => (r.uid || r.userId) !== userId);

    await classRef.update({
      pendingRequests: pendingAfter,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Add activity log
    await classRef.collection('activity').add({
      type: 'join_rejected',
      description: 'A join request was rejected',
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Join request rejected.', userId, classroomId: id });
  } catch (error) {
    console.error('Error rejecting join request:', error);
    return res.status(500).json({ error: 'Failed to reject join request', details: error.message });
  }
});

// POST /api/classrooms/:id/announcements - Teacher posts announcement
// (dual-layer: stream card + per-student notifications)
router.post('/:id/announcements', verifyAuthToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content } = req.body;
    const user = req.user;
    const db = getFirestore();

    const classRef = db.collection('classrooms').doc(id);
    const classSnap = await classRef.get();
    if (!classSnap.exists) {
      return res.status(404).json({ error: 'Classroom not found.' });
    }
    const classroomData = classSnap.data();
    const isOwner =
      classroomData.createdBy === user.uid ||
      classroomData.teacherId === user.uid ||
      classroomData.teacherUid === user.uid ||
      classroomData.ownerId === user.uid;
    if (!isOwner) {
      return res.status(403).json({ error: 'Permission denied: Only the classroom teacher can post announcements.' });
    }

    const cleanTitle = String(title || '').trim().slice(0, 200) || 'Announcement';
    const cleanContent = String(content || '').trim().slice(0, 8000);
    if (!cleanContent) {
      return res.status(400).json({ error: 'Announcement content is required.' });
    }
    const teacherName = user.name || user.displayName || user.email || classroomData.teacherName || 'Teacher';
    const cleanAttachments = Array.isArray(req.body.attachments)
      ? req.body.attachments.slice(0, 10).filter(a => a && a.fileName && (a.fileId || a.downloadURL))
      : [];

    const noticeRef = await classRef.collection('notices').add({
      title: cleanTitle,
      content: cleanContent,
      createdBy: user.uid,
      createdByName: teacherName,
      pinned: req.body.pinned === true,
      attachments: cleanAttachments,
      createdAt: FieldValue.serverTimestamp(),
    });

    // Dual-layer event: course stream card + per-student notifications
    const className = classroomData.classroomName || 'Classroom';
    try {
      await emitTeacherEvent(id, classroomData, {
        type: 'announcement',
        title: cleanTitle,
        message: `${teacherName} posted an announcement in ${className}: "${cleanContent.slice(0, 120)}${cleanContent.length > 120 ? '…' : ''}"`,
        teacherName,
        teacherId: user.uid,
        itemId: noticeRef.id,
        itemType: 'announcement',
        link: `/classroom/${id}`,
        metadata: { content: cleanContent },
      });
    } catch (err) {
      console.warn('[Classrooms Route] Stream/notification emit failed (non-blocking):', err.message || err);
    }

    return res.status(201).json({ id: noticeRef.id, title: cleanTitle, content: cleanContent, createdByName: teacherName });
  } catch (error) {
    console.error('Error posting announcement:', error);
    return res.status(500).json({ error: 'Failed to post announcement', details: error.message });
  }
});

export default router;

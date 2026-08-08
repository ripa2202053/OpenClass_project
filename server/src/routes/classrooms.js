import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';

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

// GET /api/classrooms - Fetch joined or owned classes for logged-in user
router.get('/', verifyAuthToken, async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;

    const snapshot = await db.collection('classrooms')
      .where('isActive', '==', true)
      .get();

    const classrooms = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.createdBy === uid || data.teacherId === uid) {
        classrooms.push({ id: doc.id, ...data });
      } else {
        const memberSnap = await db.collection('classrooms').doc(doc.id).collection('members').doc(uid).get();
        if (memberSnap.exists) {
          classrooms.push({ id: doc.id, ...data, memberData: memberSnap.data() });
        }
      }
    }

    return res.json(classrooms);
  } catch (error) {
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
      .orderBy('requestedAt', 'desc')
      .get();

    const requests = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
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

    // Keep the classroom document arrays + counts in sync
    const pendingAfter = (classSnap.data().pendingRequests || [])
      .filter(r => (r.uid || r.userId) !== userId);

    await classRef.update({
      memberCount: FieldValue.increment(1),
      enrolledStudents: FieldValue.arrayUnion(userId),
      pendingRequests: pendingAfter,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Add activity log
    await classRef.collection('activity').add({
      type: 'member_approved',
      description: `${reqData.displayName || 'A student'} joined the classroom`,
      userId,
      userName: reqData.displayName || 'Student',
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

export default router;

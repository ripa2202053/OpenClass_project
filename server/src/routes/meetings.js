import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';

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

// GET /api/classrooms/:classId/meetings - List meetings
router.get('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const db = getFirestore();

    const snapshot = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .orderBy('createdAt', 'desc')
      .get();

    const meetings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json(meetings);
  } catch (error) {
    console.error('Error fetching meetings:', error);
    return res.status(500).json({ error: 'Failed to fetch meetings', details: error.message });
  }
});

// POST /api/classrooms/:classId/meetings - Schedule Jitsi meeting
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { title, description, scheduledAt } = req.body;
    const user = req.user;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Meeting title is required.' });
    }

    const db = getFirestore();
    const roomName = generateRoomName();
    const meetingLink = `${MEETING_BASE_URL}_${roomName}`;
    const now = FieldValue.serverTimestamp();

    const meetingData = {
      title: title.trim(),
      description: description || '',
      roomName,
      meetingLink,
      createdBy: user.uid,
      createdByName: user.name || user.displayName || user.email || 'Teacher',
      createdAt: now,
      scheduledAt: scheduledAt || null,
      startedAt: null,
      endedAt: null,
      status: 'scheduled',
      classroomId: classId,
    };

    const docRef = await db.collection('classrooms')
      .doc(classId)
      .collection('meetings')
      .add(meetingData);

    // Add activity log
    await db.collection('classrooms').doc(classId).collection('activity').add({
      type: 'meeting_scheduled',
      description: `Meeting scheduled: ${title.trim()}`,
      userId: user.uid,
      userName: user.name || user.displayName || user.email || 'Teacher',
      timestamp: now,
    });

    return res.status(201).json({ id: docRef.id, ...meetingData, roomName, meetingLink });
  } catch (error) {
    console.error('Error creating meeting:', error);
    return res.status(500).json({ error: 'Failed to create meeting', details: error.message });
  }
});

// POST /api/classrooms/:classId/meetings/:id/start - Start meeting
router.post('/:id/start', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const db = getFirestore();
    const meetingRef = db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId);
    const snap = await meetingRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }

    await meetingRef.update({
      status: 'active',
      startedAt: FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Meeting started', id: meetingId });
  } catch (error) {
    console.error('Error starting meeting:', error);
    return res.status(500).json({ error: 'Failed to start meeting', details: error.message });
  }
});

// POST /api/classrooms/:classId/meetings/:id/end - End meeting
router.post('/:id/end', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const db = getFirestore();
    const meetingRef = db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId);
    const snap = await meetingRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }

    await meetingRef.update({
      status: 'ended',
      endedAt: FieldValue.serverTimestamp(),
    });

    return res.json({ message: 'Meeting ended', id: meetingId });
  } catch (error) {
    console.error('Error ending meeting:', error);
    return res.status(500).json({ error: 'Failed to end meeting', details: error.message });
  }
});

// DELETE /api/classrooms/:classId/meetings/:id - Cancel/delete meeting
router.delete('/:id', verifyAuthToken, async (req, res) => {
  try {
    const { classId, id: meetingId } = req.params;
    const db = getFirestore();
    await db.collection('classrooms').doc(classId).collection('meetings').doc(meetingId).delete();
    return res.json({ message: 'Meeting deleted successfully', id: meetingId });
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return res.status(500).json({ error: 'Failed to delete meeting', details: error.message });
  }
});

export default router;

import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';

const router = express.Router();

// GET /api/calendar/events - Fetch events from classrooms
router.get('/calendar/events', verifyAuthToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const db = getFirestore();

    // Find classrooms user belongs to
    const classroomsSnap = await db.collection('classrooms')
      .where('isActive', '==', true)
      .get();

    const userClassroomIds = [];
    for (const doc of classroomsSnap.docs) {
      const data = doc.data();
      if (data.createdBy === uid) {
        userClassroomIds.push(doc.id);
      } else {
        const mSnap = await db.collection('classrooms').doc(doc.id).collection('members').doc(uid).get();
        if (mSnap.exists) {
          userClassroomIds.push(doc.id);
        }
      }
    }

    const events = [];
    for (const cId of userClassroomIds) {
      // Assignments
      const aSnap = await db.collection('classrooms').doc(cId).collection('assignments').get();
      aSnap.docs.forEach(d => {
        const data = d.data();
        if (data.dueDate) {
          events.push({
            id: d.id,
            classroomId: cId,
            type: 'assignment',
            title: data.title || 'Assignment Due',
            description: data.description || '',
            dueDate: data.dueDate,
            source: 'Assignment',
            color: 'var(--warning, #f59e0b)',
          });
        }
      });

      // Quizzes
      const qSnap = await db.collection('classrooms').doc(cId).collection('quizzes').get();
      qSnap.docs.forEach(d => {
        const data = d.data();
        events.push({
          id: d.id,
          classroomId: cId,
          type: 'quiz',
          title: data.title || 'Quiz',
          description: data.description || '',
          dueDate: data.createdAt ? data.createdAt.toDate ? data.createdAt.toDate() : data.createdAt : new Date(),
          source: 'Quiz',
          color: 'var(--secondary, #3b82f6)',
        });
      });

      // Meetings
      const mSnap = await db.collection('classrooms').doc(cId).collection('meetings').get();
      mSnap.docs.forEach(d => {
        const data = d.data();
        events.push({
          id: d.id,
          classroomId: cId,
          type: 'meeting',
          title: data.title || 'Meeting',
          description: data.description || '',
          dueDate: data.scheduledAt || data.createdAt || new Date(),
          source: 'Meeting',
          color: 'var(--danger, #ef4444)',
        });
      });
    }

    return res.json(events);
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    return res.status(500).json({ error: 'Failed to fetch calendar events', details: error.message });
  }
});

// GET /api/reminders - Fetch user's personal reminders
router.get('/reminders', verifyAuthToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const db = getFirestore();

    const snapshot = await db.collection('users')
      .doc(uid)
      .collection('reminders')
      .orderBy('createdAt', 'desc')
      .get();

    const reminders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json(reminders);
  } catch (error) {
    console.error('Error fetching reminders:', error);
    return res.status(500).json({ error: 'Failed to fetch reminders', details: error.message });
  }
});

// POST /api/reminders - Create personal reminder
router.post('/reminders', verifyAuthToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { title, description, date, allDay } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Reminder title is required.' });
    }

    const db = getFirestore();
    const reminderData = {
      title: title.trim(),
      description: description || '',
      date: date || new Date().toISOString(),
      allDay: allDay !== false,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    };

    const docRef = await db.collection('users')
      .doc(uid)
      .collection('reminders')
      .add(reminderData);

    return res.status(201).json({ id: docRef.id, ...reminderData });
  } catch (error) {
    console.error('Error creating reminder:', error);
    return res.status(500).json({ error: 'Failed to create reminder', details: error.message });
  }
});

// DELETE /api/reminders/:id - Delete personal reminder
router.delete('/reminders/:id', verifyAuthToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { id: reminderId } = req.params;
    const db = getFirestore();

    await db.collection('users')
      .doc(uid)
      .collection('reminders')
      .doc(reminderId)
      .delete();

    return res.json({ message: 'Reminder deleted', id: reminderId });
  } catch (error) {
    console.error('Error deleting reminder:', error);
    return res.status(500).json({ error: 'Failed to delete reminder', details: error.message });
  }
});

export default router;

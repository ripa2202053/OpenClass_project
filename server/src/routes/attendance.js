import express from 'express';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';

const router = express.Router({ mergeParams: true });

function today() {
  return new Date().toISOString().slice(0, 10);
}

// POST /api/classrooms/:classId/attendance - Mark attendance
router.post('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { date, studentId, status, autoMark, studentIds } = req.body;
    const user = req.user;
    const dateStr = date || today();
    const db = getFirestore();
    const attRef = db.collection('classrooms').doc(classId).collection('attendance').doc(dateStr);
    const snap = await attRef.get();
    const records = snap.exists ? { ...(snap.data().records || {}) } : {};
    const now = FieldValue.serverTimestamp();

    if (autoMark) {
      // Auto mark caller as present if not marked
      if (!records[user.uid]) {
        records[user.uid] = {
          status: 'present',
          timestamp: new Date().toISOString(),
          markedBy: 'auto',
          markedByName: 'Auto'
        };
      }
    } else if (studentIds && Array.isArray(studentIds)) {
      // Bulk mark students present
      studentIds.forEach(sid => {
        records[sid] = {
          status: 'present',
          timestamp: new Date().toISOString(),
          markedBy: user.uid,
          markedByName: user.name || user.email || user.uid
        };
      });
    } else if (studentId && status) {
      // Single student mark
      records[studentId] = {
        status,
        timestamp: new Date().toISOString(),
        markedBy: user.uid,
        markedByName: user.name || user.email || user.uid
      };
    } else {
      return res.status(400).json({ error: 'Missing attendance parameters (studentId & status, or autoMark, or studentIds).' });
    }

    await attRef.set({
      date: dateStr,
      records,
      updatedAt: now,
      ...(snap.exists ? {} : { createdAt: now })
    }, { merge: true });

    return res.json({ message: 'Attendance recorded successfully', date: dateStr, records });
  } catch (error) {
    console.error('Error recording attendance:', error);
    return res.status(500).json({ error: 'Failed to record attendance', details: error.message });
  }
});

// GET /api/classrooms/:classId/attendance - Get attendance records
router.get('/', verifyAuthToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { date } = req.query;
    const db = getFirestore();

    if (date) {
      const snap = await db.collection('classrooms').doc(classId).collection('attendance').doc(date).get();
      if (!snap.exists) {
        return res.json({ date, records: {} });
      }
      return res.json({ id: snap.id, ...snap.data() });
    }

    const snapshot = await db.collection('classrooms')
      .doc(classId)
      .collection('attendance')
      .orderBy('date', 'desc')
      .get();

    const history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json(history);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    return res.status(500).json({ error: 'Failed to fetch attendance', details: error.message });
  }
});

export default router;

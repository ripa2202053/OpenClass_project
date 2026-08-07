import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';

const router = express.Router();

// GET /api/dashboard/stats
router.get('/stats', verifyAuthToken, async (req, res) => {
  try {
    const db = getFirestore();
    const uid = req.user.uid;

    // 1. Fetch classrooms created by or joined by the user
    const createdClassroomsSnap = await db.collection('classrooms')
      .where('createdBy', '==', uid)
      .where('isActive', '==', true)
      .get();

    const createdClassroomIds = createdClassroomsSnap.docs.map(doc => doc.id);
    let totalClassrooms = createdClassroomIds.length;
    let totalStudents = 0;
    let assignmentsCreated = 0;
    let quizzesCreated = 0;

    // Calculate students, assignments, and quizzes across created classrooms
    for (const doc of createdClassroomsSnap.docs) {
      const data = doc.data();
      const memberCount = data.memberCount || 1;
      totalStudents += Math.max(0, memberCount - 1);

      const assignmentsSnap = await db.collection('classrooms').doc(doc.id).collection('assignments').get();
      assignmentsCreated += assignmentsSnap.size;

      const quizzesSnap = await db.collection('classrooms').doc(doc.id).collection('quizzes').get();
      quizzesCreated += quizzesSnap.size;
    }

    // Also check all active classrooms user is a member of (if not created by user)
    const allActiveSnap = await db.collection('classrooms')
      .where('isActive', '==', true)
      .get();

    for (const cDoc of allActiveSnap.docs) {
      if (!createdClassroomIds.includes(cDoc.id)) {
        const memberSnap = await db.collection('classrooms').doc(cDoc.id).collection('members').doc(uid).get();
        if (memberSnap.exists) {
          totalClassrooms += 1;
        }
      }
    }

    return res.json({
      totalClassrooms,
      totalStudents,
      assignmentsCreated,
      quizzesCreated,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    return res.status(500).json({ error: 'Failed to fetch dashboard stats', details: error.message });
  }
});

export default router;

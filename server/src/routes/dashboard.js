import express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyAuthToken } from '../middleware/auth.js';
import { safeServerQuery, isQuotaExceededError } from '../utils/quotaGuard.js';

const router = express.Router();

// GET /api/dashboard/stats
router.get('/stats', verifyAuthToken, async (req, res) => {
  const uid = req.user.uid;
  const cacheKey = `server_dashboard_stats_${uid}`;

  try {
    const stats = await safeServerQuery(cacheKey, async () => {
      const db = getFirestore();

      const createdClassroomsSnap = await db.collection('classrooms')
        .where('createdBy', '==', uid)
        .where('isActive', '==', true)
        .get();

      const createdClassroomIds = createdClassroomsSnap.docs.map(doc => doc.id);
      let totalClassrooms = createdClassroomIds.length;
      let totalStudents = 0;
      let assignmentsCreated = 0;
      let quizzesCreated = 0;

      for (const doc of createdClassroomsSnap.docs) {
        const data = doc.data();
        const memberCount = data.memberCount || 1;
        totalStudents += Math.max(0, memberCount - 1);

        try {
          const assignmentsSnap = await db.collection('classrooms').doc(doc.id).collection('assignments').get();
          assignmentsCreated += assignmentsSnap.size;
        } catch (e) {}

        try {
          const quizzesSnap = await db.collection('classrooms').doc(doc.id).collection('quizzes').get();
          quizzesCreated += quizzesSnap.size;
        } catch (e) {}
      }

      const allActiveSnap = await db.collection('classrooms')
        .where('isActive', '==', true)
        .get();

      for (const cDoc of allActiveSnap.docs) {
        if (!createdClassroomIds.includes(cDoc.id)) {
          const data = cDoc.data();
          if (
            data.teacherId === uid ||
            data.teacherUid === uid ||
            (Array.isArray(data.members) && data.members.includes(uid)) ||
            (Array.isArray(data.enrolledStudents) && data.enrolledStudents.includes(uid))
          ) {
            totalClassrooms += 1;
          }
        }
      }

      return {
        totalClassrooms,
        totalStudents,
        assignmentsCreated,
        quizzesCreated,
        timestamp: new Date().toISOString()
      };
    }, {
      totalClassrooms: 0,
      totalStudents: 0,
      assignmentsCreated: 0,
      quizzesCreated: 0,
      timestamp: new Date().toISOString()
    }, 30000);

    return res.json(stats);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      console.warn('[Dashboard Route] Firestore RESOURCE_EXHAUSTED. Returning fallback stats.');
      return res.json({
        totalClassrooms: 0,
        totalStudents: 0,
        assignmentsCreated: 0,
        quizzesCreated: 0,
        timestamp: new Date().toISOString()
      });
    }
    console.error('Error fetching dashboard stats:', error);
    return res.status(500).json({ error: 'Failed to fetch dashboard stats', details: error.message });
  }
});

export default router;


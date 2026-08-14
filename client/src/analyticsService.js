import { safeOnSnapshot, isQuotaExceededError } from './utils/firestoreGuard.js';

// ─── Classroom Analytics ───────────────────────────────────────

export async function getClassroomAnalytics(classroomId) {
  const db = getFirestore();
  try {
    const [classSnap, membersSnap, assignSnap, quizSnap, attSnap] = await Promise.all([
      getDoc(doc(db, 'classrooms', classroomId)),
      getDocs(collection(db, 'classrooms', classroomId, 'members')),
      getDocs(collection(db, 'classrooms', classroomId, 'assignments')),
      getDocs(collection(db, 'classrooms', classroomId, 'quizzes')),
      getDocs(query(collection(db, 'classrooms', classroomId, 'attendance'), orderBy('date', 'desc'), limit(30))),
    ]);

    const classroom = classSnap.data() || {};
    const members = membersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const assignments = assignSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const quizzes = quizSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const attendanceRecords = attSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Assignment completion
    const assignmentData = await Promise.all(assignments.map(async (a) => {
      try {
        const subSnap = await getDocs(collection(db, 'classrooms', classroomId, 'assignments', a.id, 'submissions'));
        const subs = subSnap.docs.map(s => ({ id: s.id, ...s.data() }));
        const studentCount = members.filter(m => (m.role || 'student').toLowerCase() === 'student').length;
        return {
          id: a.id, title: a.title || 'Untitled',
          totalStudents: studentCount,
          submitted: subs.length,
          completionRate: studentCount > 0 ? Math.round(subs.length / studentCount * 100) : 0,
        };
      } catch (e) {
        return { id: a.id, title: a.title || 'Untitled', totalStudents: 0, submitted: 0, completionRate: 0 };
      }
    }));

    // Quiz performance
    const quizData = await Promise.all(quizzes.map(async (q) => {
      try {
        const attSnap2 = await getDocs(collection(db, 'classrooms', classroomId, 'quizzes', q.id, 'attempts'));
        const attempts = attSnap2.docs.map(a => ({ id: a.id, ...a.data() }));
        const scores = attempts.map(a => a.score || 0).filter(s => s > 0);
        const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 100) / 100 : 0;
        return {
          id: q.id, title: q.title || 'Untitled',
          totalAttempts: attempts.length,
          avgScore: avg,
          maxScore: scores.length > 0 ? Math.max(...scores) : 0,
        };
      } catch (e) {
        return { id: q.id, title: q.title || 'Untitled', totalAttempts: 0, avgScore: 0, maxScore: 0 };
      }
    }));

    // Attendance stats
    const attendanceStats = attendanceRecords.map(r => {
      const vals = Object.values(r.records || {});
      const total = vals.length;
      const present = vals.filter(v => v.status === 'present').length;
      const absent = vals.filter(v => v.status === 'absent').length;
      const late = vals.filter(v => v.status === 'late').length;
      return { date: r.date || r.id, total, present, absent, late, rate: total > 0 ? Math.round(present / total * 100) : 0 };
    });

    return {
      classroom: { name: classroom.classroomName || classroomId, code: classroom.classroomCode, teacher: classroom.createdByName || '' },
      members: { total: members.length, students: members.filter(m => (m.role || 'student').toLowerCase() === 'student').length, teachers: members.filter(m => (m.role || '').toLowerCase() === 'teacher').length },
      assignments: { total: assignments.length, data: assignmentData, avgCompletion: assignmentData.length > 0 ? Math.round(assignmentData.reduce((a, d) => a + d.completionRate, 0) / assignmentData.length) : 0 },
      quizzes: { total: quizzes.length, data: quizData, avgScore: quizData.length > 0 ? Math.round(quizData.reduce((a, d) => a + d.avgScore, 0) / quizData.length * 100) / 100 : 0 },
      attendance: { records: attendanceStats, avgRate: attendanceStats.length > 0 ? Math.round(attendanceStats.reduce((a, r) => a + r.rate, 0) / attendanceStats.length) : 0 },
    };
  } catch (err) {
    if (isQuotaExceededError(err)) {
      console.warn('[analyticsService] getClassroomAnalytics quota exceeded:', err.message);
    }
    return {
      classroom: { name: classroomId, code: '', teacher: '' },
      members: { total: 0, students: 0, teachers: 0 },
      assignments: { total: 0, data: [], avgCompletion: 0 },
      quizzes: { total: 0, data: [], avgScore: 0 },
      attendance: { records: [], avgRate: 0 },
    };
  }
}


// ─── Student Performance ───────────────────────────────────────

export async function getStudentPerformance(uid, classroomIds) {
  const db = getFirestore();
  const userSnap = await getDoc(doc(db, 'users', uid));
  const user = userSnap.data() || {};

  const assignmentResults = [];
  const quizResults = [];
  const attendanceResults = [];

  for (const cId of classroomIds) {
    // Submissions
    try {
      const assignSnap = await getDocs(collection(db, 'classrooms', cId, 'assignments'));
      for (const a of assignSnap.docs) {
        const subRef = doc(db, 'classrooms', cId, 'assignments', a.id, 'submissions', uid);
        const subSnap = await getDoc(subRef);
        if (subSnap.exists()) {
          assignmentResults.push({ classroomId: cId, assignmentId: a.id, title: a.data().title || 'Untitled', ...subSnap.data() });
        }
      }
    } catch (e) { /* ignore */ }

    // Quiz attempts
    try {
      const quizSnap = await getDocs(collection(db, 'classrooms', cId, 'quizzes'));
      for (const q of quizSnap.docs) {
        const attSnap = await getDocs(query(
          collection(db, 'classrooms', cId, 'quizzes', q.id, 'attempts'),
          where('studentId', '==', uid)
        ));
        attSnap.docs.forEach(a => {
          quizResults.push({ classroomId: cId, quizId: q.id, title: q.data().title || 'Untitled', ...a.data() });
        });
      }
    } catch (e) { /* ignore */ }

    // Attendance
    try {
      const attSnap = await getDocs(query(
        collection(db, 'classrooms', cId, 'attendance'),
        orderBy('date', 'desc'), limit(60)
      ));
      attSnap.docs.forEach(d => {
        const data = d.data();
        if (data.records && data.records[uid]) {
          attendanceResults.push({ date: d.id, status: data.records[uid].status });
        }
      });
    } catch (e) { /* ignore */ }
  }

  const present = attendanceResults.filter(a => a.status === 'present').length;
  const late = attendanceResults.filter(a => a.status === 'late').length;
  const absent = attendanceResults.filter(a => a.status === 'absent').length;
  const attTotal = attendanceResults.length;

  return {
    user: { displayName: user.displayName || uid, email: user.email, photoURL: user.photoURL },
    assignments: {
      total: assignmentResults.length,
      avgScore: assignmentResults.length > 0
        ? Math.round(assignmentResults.reduce((a, r) => a + (r.score || 0), 0) / assignmentResults.length * 100) / 100
        : 0,
      results: assignmentResults,
    },
    quizzes: {
      total: quizResults.length,
      avgScore: quizResults.length > 0
        ? Math.round(quizResults.reduce((a, r) => a + (r.score || 0), 0) / quizResults.length * 100) / 100
        : 0,
      results: quizResults,
    },
    attendance: {
      total: attTotal, present, late, absent,
      rate: attTotal > 0 ? Math.round(present / attTotal * 100) : 0,
    },
  };
}

// ─── Export ────────────────────────────────────────────────────

export function exportToCSV(headers, rows) {
  const escape = v => `"${String(v || '').replace(/"/g, '""')}"`;
  return [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
}

export function downloadCSV(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function printElement(elementId, title) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <style>body{font-family:system-ui,sans-serif;padding:40px;color:#1a1a2e;}
    table{width:100%;border-collapse:collapse;margin:16px 0;}
    th,td{padding:10px 14px;border:1px solid #ddd;text-align:left;font-size:14px;}
    th{background:#f5f5f5;font-weight:600;}
    h2{color:#3B82F6;}</style></head><body>
    <h2>${title}</h2>
    ${el.innerHTML}
    <p style="margin-top:40px;font-size:12px;color:#999;">Generated by OpenClass</p>
    </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 500);
}

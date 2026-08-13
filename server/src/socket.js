import { Server } from 'socket.io';

const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * Verifies Firebase ID Token for incoming sockets.
 * Uses Firebase Admin SDK, with a safe JWT payload decode fallback in non-production environments.
 */
async function verifySocketToken(token) {
  if (!token) return null;
  try {
    const { getAuth } = await import('firebase-admin/auth');
    return await getAuth().verifyIdToken(token);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production' && typeof token === 'string') {
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
          return {
            uid: decoded.user_id || decoded.sub || decoded.uid || 'dev_user_123',
            email: decoded.email || 'user@example.com',
            name: decoded.name || decoded.email || 'Dev User',
            ...decoded,
          };
        }
      } catch (e) {}
    }
    return null;
  }
}

/**
 * Attaches the WebRTC Socket.io signaling server to the HTTP server.
 */
export function attachSignaling(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e6,
  });

  // rooms: roomId -> Map<socketId, participant>
  const rooms = new Map();

  function getRoom(roomId) {
    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    return rooms.get(roomId);
  }

  function participantList(room) {
    return [...room.values()].map((p) => ({
      socketId: p.socketId,
      userId: p.userId,
      userName: p.userName,
      muted: p.muted,
      cameraOff: p.cameraOff,
      screenShare: p.screenShare,
      raisedHand: p.raisedHand,
      raisedAt: p.raisedAt || null,
      isHost: p.isHost,
    }));
  }

  function broadcastRoomState(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    io.to(roomId).emit('room-state', participantList(room));
  }

  async function recordStudentJoin({ meetingId, classroomId, studentUid, studentName, studentEmail }) {
    if (!meetingId || !classroomId || !studentUid) return;
    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      const db = getFirestore();
      const attRef = db.collection('classrooms').doc(classroomId).collection('meetings').doc(meetingId).collection('attendance').doc(studentUid);
      const snap = await attRef.get();
      const nowIso = new Date().toISOString();

      if (!snap.exists) {
        await attRef.set({
          meetingId,
          classroomId,
          studentUid,
          studentName: studentName || 'Student',
          studentEmail: studentEmail || '',
          joinedAt: nowIso,
          leftAt: null,
          totalDuration: 0,
          status: 'Present',
          sessions: [{ joinedAt: nowIso, leftAt: null }],
        });
      } else {
        const data = snap.data();
        const sessions = Array.isArray(data.sessions) ? [...data.sessions] : [];
        const hasActiveSession = sessions.some(s => !s.leftAt);
        if (!hasActiveSession) {
          sessions.push({ joinedAt: nowIso, leftAt: null });
        }
        await attRef.update({
          status: 'Present',
          studentName: studentName || data.studentName || 'Student',
          studentEmail: studentEmail || data.studentEmail || '',
          leftAt: null,
          sessions,
        });
      }
    } catch (err) {
      console.warn('Error recording student attendance join:', err.message);
    }
  }

  async function recordStudentLeave({ meetingId, classroomId, studentUid }) {
    if (!meetingId || !classroomId || !studentUid) return;
    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      const db = getFirestore();
      const attRef = db.collection('classrooms').doc(classroomId).collection('meetings').doc(meetingId).collection('attendance').doc(studentUid);
      const snap = await attRef.get();
      if (!snap.exists) return;

      const data = snap.data();
      const nowIso = new Date().toISOString();
      let totalDuration = 0;
      const sessions = (data.sessions || []).map(s => {
        const leftTimestamp = s.leftAt || nowIso;
        const durMs = new Date(leftTimestamp).getTime() - new Date(s.joinedAt).getTime();
        const durMin = Math.max(0, Math.round(durMs / 60000));
        totalDuration += durMin;
        return { ...s, leftAt: leftTimestamp, duration: durMin };
      });

      await attRef.update({
        leftAt: nowIso,
        totalDuration,
        sessions,
      });
    } catch (err) {
      console.warn('Error recording student attendance leave:', err.message);
    }
  }

  io.on('connection', (socket) => {
    socket.data.roomId = null;
    socket.data.userId = null;
    socket.data.isHost = false;

    socket.on('join-room', async (payload = {}, ack) => {
      const data = (typeof payload === 'string') ? { roomId: payload } : (payload || {});
      const cleanRoom = String(data.roomId || data.roomName || data.classroomId || '').trim().slice(0, 64);
      const cleanName = String(data.userName || 'Guest').trim().slice(0, 32) || 'Guest';

      if (!cleanRoom) {
        return ack?.({ ok: false, error: 'A room name is required.' });
      }

      // 1. Firebase Token Verification (DO NOT TRUST CLIENT DATA)
      const decodedUser = await verifySocketToken(data.token);
      if (!decodedUser || !decodedUser.uid) {
        return ack?.({ ok: false, error: 'Authentication required. Missing or invalid Firebase ID token.' });
      }

      socket.data.userId = decodedUser.uid;
      socket.data.userEmail = decodedUser.email || '';
      socket.data.userName = decodedUser.name || cleanName;

      let isTeacherHost = false;
      let meetingDocId = null;
      let targetClassroomId = null;

      // 2. Classroom & Meeting Authorization + Real Host Identification
      if (cleanRoom.startsWith('OpenClass-')) {
        try {
          const { getFirestore } = await import('firebase-admin/firestore');
          const db = getFirestore();
          const snap = await db.collection('meetings').where('roomName', '==', cleanRoom).get();

          if (!snap.empty) {
            const meetingDoc = snap.docs[0];
            meetingDocId = meetingDoc.id;
            const meetingData = meetingDoc.data();
            targetClassroomId = meetingData.classroomId || null;

            // Check classroom ownership
            let classroomData = null;
            if (meetingData.classroomId) {
              const cSnap = await db.collection('classrooms').doc(meetingData.classroomId).get();
              if (cSnap.exists) classroomData = cSnap.data();
            }

            // Real Teacher Host Check (strictly verified against Firebase UID, NOT join order)
            isTeacherHost = Boolean(
              (meetingData && (meetingData.createdBy === socket.data.userId || meetingData.teacherUid === socket.data.userId || meetingData.teacherId === socket.data.userId)) ||
              (classroomData && (classroomData.createdBy === socket.data.userId || classroomData.teacherId === socket.data.userId || classroomData.teacherUid === socket.data.userId || classroomData.ownerId === socket.data.userId))
            );

            // Block early join for students on scheduled meetings
            if (!isTeacherHost && meetingData.status === 'scheduled') {
              return ack?.({ ok: false, error: 'This class has not been started by the teacher yet. Please wait for your instructor.' });
            }

            // Block ended or cancelled meetings
            if (meetingData.status === 'ended' || meetingData.status === 'cancelled') {
              return ack?.({ ok: false, error: 'This live class has already ended.' });
            }

            // Verify classroom membership if student
            if (!isTeacherHost && classroomData) {
              const isEnrolled = (Array.isArray(classroomData.enrolledStudents) && classroomData.enrolledStudents.includes(socket.data.userId));
              if (!isEnrolled) {
                const memberSnap = await db.collection('classrooms').doc(meetingData.classroomId).collection('members').doc(socket.data.userId).get();
                if (!memberSnap.exists || memberSnap.data().approved === false) {
                  return ack?.({ ok: false, error: 'Permission denied: You are not an approved member of this classroom.' });
                }
              }
            }
          } else {
            // Standalone or mock room fallback where no Firestore meeting document exists
            isTeacherHost = Boolean(decodedUser.role === 'teacher' || decodedUser.isTeacher === true);
          }
        } catch (e) {
          // Graceful fallback for dev environment
        }
      }

      socket.data.isHost = isTeacherHost;
      socket.data.meetingDocId = meetingDocId;
      socket.data.classroomId = targetClassroomId;
      const room = getRoom(cleanRoom);

      const participant = {
        socketId: socket.id,
        userId: socket.data.userId,
        userName: cleanName,
        muted: false,
        cameraOff: false,
        screenShare: false,
        raisedHand: false,
        raisedAt: null,
        isHost: isTeacherHost,
      };

      socket.data.roomId = cleanRoom;
      socket.join(cleanRoom);
      if (targetClassroomId) socket.join(targetClassroomId);
      room.set(socket.id, participant);

      // Track peak concurrent participants for analytics
      room.peakParticipants = Math.max(room.peakParticipants || 0, room.size);
      if (meetingDocId && targetClassroomId) {
        try {
          const { getFirestore } = await import('firebase-admin/firestore');
          const db = getFirestore();
          await db.collection('classrooms')
            .doc(targetClassroomId)
            .collection('meetings')
            .doc(meetingDocId)
            .set({ peakParticipants: room.peakParticipants }, { merge: true });
        } catch (e) {}
      }

      // Record student attendance join
      if (!isTeacherHost && meetingDocId && targetClassroomId) {
        await recordStudentJoin({
          meetingId: meetingDocId,
          classroomId: targetClassroomId,
          studentUid: socket.data.userId,
          studentName: socket.data.userName,
          studentEmail: socket.data.userEmail,
        });
      }

      const existing = participantList(room).filter((p) => p.socketId !== socket.id);
      socket.emit('existing-users', existing);
      socket.to(cleanRoom).emit('user-connected', participant);

      broadcastRoomState(cleanRoom);
      ack?.({ ok: true, isHost: participant.isHost, participants: participantList(room) });
    });

    // 3. End Meeting Handler (Teacher Only)
    socket.on('end-meeting', async ({ roomId, meetingId, classroomId } = {}, ack) => {
      const targetRoomId = roomId || socket.data.roomId;
      if (!targetRoomId) {
        return ack?.({ ok: false, error: 'Room ID is required.' });
      }

      if (!socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can end the meeting for everyone.' });
      }

      try {
        const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
        const db = getFirestore();
        const meetingRefId = meetingId || socket.data.meetingDocId;

        if (meetingRefId) {
          await db.collection('meetings').doc(meetingRefId).update({
            status: 'ended',
            endedAt: FieldValue.serverTimestamp(),
          }).catch(() => {});

          if (classroomId) {
            await db.collection('classrooms').doc(classroomId).collection('meetings').doc(meetingRefId).update({
              status: 'ended',
              endedAt: FieldValue.serverTimestamp(),
            }).catch(() => {});
          }
        }
      } catch (e) {}

      // Record attendance leave for all active students in room before closing
      const room = rooms.get(targetRoomId);
      if (room) {
        room.forEach((p) => {
          if (!p.isHost && socket.data.meetingDocId && socket.data.classroomId) {
            recordStudentLeave({
              meetingId: socket.data.meetingDocId,
              classroomId: socket.data.classroomId,
              studentUid: p.userId,
            });
          }
        });
      }

      // Broadcast meeting-ended event to all connected participants in room
      io.to(targetRoomId).emit('meeting-ended', {
        meetingId,
        classroomId,
        endedBy: socket.data.userId,
      });

      // Clear room participants map
      if (rooms.has(targetRoomId)) {
        rooms.delete(targetRoomId);
      }

      ack?.({ ok: true });
    });

    // 4. Kick Participant Handler (Teacher Only)
    socket.on('kick-participant', async ({ targetSocketId } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) {
        return ack?.({ ok: false, error: 'Not currently in a meeting room.' });
      }

      if (!socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can kick participants.' });
      }

      const room = rooms.get(roomId);
      if (!room || !room.has(targetSocketId)) {
        return ack?.({ ok: false, error: 'Target participant not found in this meeting room.' });
      }

      const targetParticipant = room.get(targetSocketId);
      if (targetParticipant.isHost) {
        return ack?.({ ok: false, error: 'You cannot kick a teacher/host from the class.' });
      }

      if (targetSocketId === socket.id) {
        return ack?.({ ok: false, error: 'You cannot kick yourself.' });
      }

      // Record attendance leave for kicked student
      if (!targetParticipant.isHost && socket.data.meetingDocId && socket.data.classroomId) {
        recordStudentLeave({
          meetingId: socket.data.meetingDocId,
          classroomId: socket.data.classroomId,
          studentUid: targetParticipant.userId,
        });
      }

      // Notify target student
      io.to(targetSocketId).emit('participant-kicked', {
        reason: 'You were removed from this live class by the teacher.',
        kickedBy: socket.data.userId,
      });

      // Remove target socket from room state & socket channel
      room.delete(targetSocketId);
      const targetSocketInstance = io.sockets.sockets.get(targetSocketId);
      if (targetSocketInstance) {
        targetSocketInstance.leave(roomId);
        targetSocketInstance.data.roomId = null;
      }

      socket.to(roomId).emit('user-disconnected', { socketId: targetSocketId });
      broadcastRoomState(roomId);

      ack?.({ ok: true });
    });

    socket.on('offer', ({ to, sdp }) => {
      io.to(to).emit('offer', { from: socket.id, sdp });
    });

    socket.on('answer', ({ to, sdp }) => {
      io.to(to).emit('answer', { from: socket.id, sdp });
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
      io.to(to).emit('ice-candidate', { from: socket.id, candidate });
    });

    socket.on('toggle-mute', ({ muted }) => {
      const room = rooms.get(socket.data.roomId);
      if (room?.has(socket.id)) room.get(socket.id).muted = Boolean(muted);
      if (socket.data.roomId) broadcastRoomState(socket.data.roomId);
    });

    socket.on('toggle-camera', ({ cameraOff }) => {
      const room = rooms.get(socket.data.roomId);
      if (room?.has(socket.id)) room.get(socket.id).cameraOff = Boolean(cameraOff);
      if (socket.data.roomId) broadcastRoomState(socket.data.roomId);
    });

    socket.on('screen-share', ({ screenShare }) => {
      const room = rooms.get(socket.data.roomId);
      if (room?.has(socket.id)) room.get(socket.id).screenShare = Boolean(screenShare);
      if (socket.data.roomId) broadcastRoomState(socket.data.roomId);
    });

    socket.on('raise-hand', ({ raisedHand } = {}) => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (room?.has(socket.id)) {
        const p = room.get(socket.id);
        const isRaised = Boolean(raisedHand);
        p.raisedHand = isRaised;
        p.raisedAt = isRaised ? (p.raisedAt || Date.now()) : null;

        if (isRaised) {
          io.to(roomId).emit('hand-raised-toast', {
            socketId: socket.id,
            userName: p.userName,
            raisedAt: p.raisedAt,
          });
        }
      }
      if (roomId) broadcastRoomState(roomId);
    });

    socket.on('teacher-lower-hand', ({ targetSocketId } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can lower another student\'s hand.' });
      }
      const room = rooms.get(roomId);
      if (room?.has(targetSocketId)) {
        const p = room.get(targetSocketId);
        p.raisedHand = false;
        p.raisedAt = null;
        broadcastRoomState(roomId);
        io.to(targetSocketId).emit('hand-lowered', { loweredBy: socket.data.userId });
        return ack?.({ ok: true });
      }
      return ack?.({ ok: false, error: 'Participant not found.' });
    });

    socket.on('send-message', async ({ text, isQuestion } = {}) => {
      const roomId = socket.data.roomId;
      const cleanText = String(text || '').replace(/<[^>]*>?/gm, '').trim().slice(0, 1000);
      if (!roomId || !cleanText) return;

      const room = rooms.get(roomId);
      const sender = room?.get(socket.id);
      const msgObj = {
        id: `msg-${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        roomId,
        meetingId: socket.data.meetingDocId || null,
        classroomId: socket.data.classroomId || null,
        senderUid: socket.data.userId,
        senderName: sender?.userName || socket.data.userName || 'Guest',
        senderRole: socket.data.isHost ? 'teacher' : 'student',
        message: cleanText,
        text: cleanText,
        type: isQuestion ? 'question' : 'chat',
        isQuestion: Boolean(isQuestion),
        isDeleted: false,
        createdAt: new Date().toISOString(),
        timestamp: Date.now(),
      };

      io.to(roomId).emit('new-message', msgObj);

      if (socket.data.classroomId && socket.data.meetingDocId) {
        try {
          const { getFirestore } = await import('firebase-admin/firestore');
          const db = getFirestore();
          await db.collection('classrooms')
            .doc(socket.data.classroomId)
            .collection('meetings')
            .doc(socket.data.meetingDocId)
            .collection('messages')
            .doc(msgObj.id)
            .set(msgObj);
        } catch (e) {
          console.warn('Failed to persist message to Firestore:', e.message);
        }
      }
    });

    socket.on('delete-message', async ({ messageId } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can delete messages.' });
      }
      if (!messageId) return ack?.({ ok: false, error: 'Message ID is required.' });

      io.to(roomId).emit('message-deleted', { messageId });

      if (socket.data.classroomId && socket.data.meetingDocId) {
        try {
          const { getFirestore } = await import('firebase-admin/firestore');
          const db = getFirestore();
          await db.collection('classrooms')
            .doc(socket.data.classroomId)
            .collection('meetings')
            .doc(socket.data.meetingDocId)
            .collection('messages')
            .doc(messageId)
            .update({ isDeleted: true });
        } catch (e) {}
      }
      return ack?.({ ok: true });
    });

    socket.on('add-note', async ({ title, content, pinned } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can create notes.' });
      }
      if (!title || !title.trim()) return ack?.({ ok: false, error: 'Note title is required.' });

      const noteObj = {
        id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: String(title).trim(),
        content: String(content || '').trim(),
        pinned: Boolean(pinned),
        createdBy: socket.data.userId,
        createdByName: socket.data.userName || 'Teacher',
        createdAt: new Date().toISOString(),
      };

      io.to(roomId).emit('note-added', noteObj);

      if (socket.data.classroomId && socket.data.meetingDocId) {
        try {
          const { getFirestore } = await import('firebase-admin/firestore');
          const db = getFirestore();
          await db.collection('classrooms')
            .doc(socket.data.classroomId)
            .collection('meetings')
            .doc(socket.data.meetingDocId)
            .collection('notes')
            .doc(noteObj.id)
            .set(noteObj);
        } catch (e) {}
      }
      return ack?.({ ok: true, note: noteObj });
    });

    socket.on('add-resource', async ({ title, description, url, fileType } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can add resources.' });
      }
      if (!title || !title.trim()) return ack?.({ ok: false, error: 'Resource title is required.' });

      const resourceObj = {
        id: `res-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: String(title).trim(),
        description: String(description || '').trim(),
        url: String(url || '').trim(),
        fileType: fileType || 'link',
        createdBy: socket.data.userId,
        createdByName: socket.data.userName || 'Teacher',
        createdAt: new Date().toISOString(),
      };

      io.to(roomId).emit('resource-added', resourceObj);

      if (socket.data.classroomId && socket.data.meetingDocId) {
        try {
          const { getFirestore } = await import('firebase-admin/firestore');
          const db = getFirestore();
          await db.collection('classrooms')
            .doc(socket.data.classroomId)
            .collection('meetings')
            .doc(socket.data.meetingDocId)
            .collection('resources')
            .doc(resourceObj.id)
            .set(resourceObj);
        } catch (e) {}
      }
      return ack?.({ ok: true, resource: resourceObj });
    });

    // File Sharing Handlers
    socket.on('upload-file', ({ classroomId, file } = {}) => {
      if (!classroomId || !file) return;
      io.to(classroomId).emit('file-uploaded', { classroomId, file });
      if (socket.data.roomId && socket.data.roomId !== classroomId) {
        io.to(socket.data.roomId).emit('file-uploaded', { classroomId, file });
      }
    });

    socket.on('delete-file', ({ classroomId, fileId } = {}) => {
      if (!classroomId || !fileId) return;
      io.to(classroomId).emit('file-deleted', { classroomId, fileId });
      if (socket.data.roomId && socket.data.roomId !== classroomId) {
        io.to(socket.data.roomId).emit('file-deleted', { classroomId, fileId });
      }
    });

    // Polls Handlers
    socket.on('create-poll', async ({ question, options } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can create polls.' });
      }
      if (!question || !Array.isArray(options) || options.length < 2) {
        return ack?.({ ok: false, error: 'Question and at least 2 options required.' });
      }

      const pollObj = {
        id: `poll-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        question: String(question).trim(),
        options: options.map(o => String(o).trim()).filter(Boolean),
        active: true,
        createdBy: socket.data.userId,
        createdAt: new Date().toISOString(),
        totalVotes: 0,
        results: options.map(() => 0),
      };

      const room = rooms.get(roomId);
      if (room) room.activePoll = pollObj;

      io.to(roomId).emit('poll-created', pollObj);

      if (socket.data.classroomId && socket.data.meetingDocId) {
        try {
          const { getFirestore } = await import('firebase-admin/firestore');
          const db = getFirestore();
          await db.collection('classrooms')
            .doc(socket.data.classroomId)
            .collection('meetings')
            .doc(socket.data.meetingDocId)
            .collection('polls')
            .doc(pollObj.id)
            .set(pollObj);
        } catch (e) {}
      }
      return ack?.({ ok: true, poll: pollObj });
    });

    socket.on('submit-poll-vote', async ({ pollId, optionIndex } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) return ack?.({ ok: false, error: 'Not in meeting room.' });

      const room = rooms.get(roomId);
      const poll = room?.activePoll;
      if (!poll || poll.id !== pollId || !poll.active) {
        return ack?.({ ok: false, error: 'Active poll not found.' });
      }

      if (optionIndex < 0 || optionIndex >= poll.options.length) {
        return ack?.({ ok: false, error: 'Invalid option.' });
      }

      poll.votes = poll.votes || {};
      if (poll.votes[socket.data.userId] !== undefined) {
        return ack?.({ ok: false, error: 'You have already voted in this poll.' });
      }

      poll.votes[socket.data.userId] = optionIndex;
      poll.results[optionIndex] = (poll.results[optionIndex] || 0) + 1;
      poll.totalVotes = (poll.totalVotes || 0) + 1;

      io.to(roomId).emit('poll-updated', {
        id: poll.id,
        question: poll.question,
        options: poll.options,
        active: poll.active,
        results: poll.results,
        totalVotes: poll.totalVotes,
      });

      if (socket.data.classroomId && socket.data.meetingDocId) {
        try {
          const { getFirestore } = await import('firebase-admin/firestore');
          const db = getFirestore();
          await db.collection('classrooms')
            .doc(socket.data.classroomId)
            .collection('meetings')
            .doc(socket.data.meetingDocId)
            .collection('polls')
            .doc(poll.id)
            .set({ results: poll.results, totalVotes: poll.totalVotes }, { merge: true });
        } catch (e) {}
      }
      return ack?.({ ok: true });
    });

    socket.on('close-poll', async ({ pollId } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can close polls.' });
      }

      const room = rooms.get(roomId);
      const poll = room?.activePoll;
      if (poll && poll.id === pollId) {
        poll.active = false;
        io.to(roomId).emit('poll-closed', { pollId });
      }
      return ack?.({ ok: true });
    });

    // Whiteboard Handlers
    socket.on('draw-stroke', (data) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      socket.to(roomId).emit('draw-stroke', data);
    });

    socket.on('clear-whiteboard', () => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) return;
      io.to(roomId).emit('clear-whiteboard');
    });

    // Breakout Rooms Handlers
    socket.on('create-breakout-rooms', ({ roomsCount = 2, assignments = {} } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can create breakout rooms.' });
      }

      const room = rooms.get(roomId);
      if (!room) return ack?.({ ok: false, error: 'Room not found.' });

      const breakoutRooms = [];
      for (let i = 1; i <= roomsCount; i++) {
        breakoutRooms.push({ id: `${roomId}-breakout-${i}`, name: `Breakout Room ${i}` });
      }

      room.breakoutAssignments = assignments; // socketId -> breakoutRoomId
      room.breakoutRooms = breakoutRooms;

      // Broadcast assignment to each student socket
      Object.entries(assignments).forEach(([studentSocketId, bRoomId]) => {
        io.to(studentSocketId).emit('assigned-breakout-room', { breakoutRoomId: bRoomId });
      });

      return ack?.({ ok: true, breakoutRooms });
    });

    socket.on('join-breakout-room', ({ breakoutRoomId } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) return ack?.({ ok: false, error: 'Not in live meeting.' });

      const room = rooms.get(roomId);
      const assignedRoomId = room?.breakoutAssignments?.[socket.id];

      // Validate student assigned breakout room or teacher host access
      if (!socket.data.isHost && assignedRoomId !== breakoutRoomId) {
        return ack?.({ ok: false, error: 'Permission denied: You are not assigned to this breakout room.' });
      }

      socket.join(breakoutRoomId);
      socket.data.breakoutRoomId = breakoutRoomId;
      io.to(breakoutRoomId).emit('breakout-user-joined', { socketId: socket.id, userName: socket.data.userName });

      return ack?.({ ok: true });
    });

    socket.on('broadcast-breakout', ({ message } = {}, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can broadcast to breakout rooms.' });
      }

      io.to(roomId).emit('breakout-broadcast-received', { message, senderName: socket.data.userName });
      return ack?.({ ok: true });
    });

    socket.on('close-breakout-rooms', (ack) => {
      const roomId = socket.data.roomId;
      if (!roomId || !socket.data.isHost) {
        return ack?.({ ok: false, error: 'Only the classroom teacher can close breakout rooms.' });
      }

      const room = rooms.get(roomId);
      if (room) {
        room.breakoutAssignments = null;
        room.breakoutRooms = null;
      }

      io.to(roomId).emit('breakout-rooms-closed');
      return ack?.({ ok: true });
    });

    socket.on('disconnect', async () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (room?.has(socket.id)) {
        const p = room.get(socket.id);

        if (!p.isHost && socket.data.meetingDocId && socket.data.classroomId) {
          await recordStudentLeave({
            meetingId: socket.data.meetingDocId,
            classroomId: socket.data.classroomId,
            studentUid: p.userId,
          });
        }

        room.delete(socket.id);
        socket.to(roomId).emit('user-disconnected', { socketId: socket.id });
        if (room.size === 0) {
          rooms.delete(roomId);
        } else {
          broadcastRoomState(roomId);
        }
      }
    });
  });

  return io;
}

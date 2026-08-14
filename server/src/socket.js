import { Server } from 'socket.io';
import { verifySocketToken } from './middleware/auth.js';

export function attachSignaling(httpServer) {
  const allowedOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://open-class-project-client.vercel.app',
    ...(process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',').map((s) => s.trim()) : []),
  ];

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || (origin && origin.endsWith('.vercel.app'))) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 1e6,
  });

  const rooms = new Map();

  function broadcastRoomState(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const list = Array.from(room.values()).map((p) => ({
      socketId: p.socketId,
      userId: p.userId,
      userName: p.userName,
      isHost: p.isHost,
      isMuted: p.isMuted,
      isCameraOff: p.isCameraOff,
      isScreenSharing: p.isScreenSharing,
      raisedHand: p.raisedHand,
    }));
    io.to(roomId).emit('room-state', list);
  }

  io.on('connection', (socket) => {
    socket.data.roomId = null;
    socket.data.userId = null;

    socket.on('join-room', async (payload = {}, ack) => {
      const data = typeof payload === 'string' ? { roomId: payload } : (payload || {});
      const cleanRoom = String(data.roomId || data.roomName || '').trim();
      const cleanName = String(data.userName || 'User').trim() || 'User';

      if (!cleanRoom) {
        return ack?.({ ok: false, error: 'A room name is required.' });
      }

      // Verify token if supplied
      let decodedUser = null;
      if (data.token) {
        decodedUser = await verifySocketToken(data.token);
      }

      const userId = decodedUser?.uid || `anon-${socket.id}`;
      const userName = decodedUser?.name || cleanName;

      socket.data.roomId = cleanRoom;
      socket.data.userId = userId;
      socket.data.userName = userName;

      socket.join(cleanRoom);

      if (!rooms.has(cleanRoom)) {
        rooms.set(cleanRoom, new Map());
      }
      const room = rooms.get(cleanRoom);

      const isHost = Boolean(data.isHost);
      socket.data.isHost = isHost;

      const participant = {
        socketId: socket.id,
        userId,
        userName,
        isHost,
        isMuted: false,
        isCameraOff: false,
        isScreenSharing: false,
        raisedHand: false,
      };

      room.set(socket.id, participant);

      socket.to(cleanRoom).emit('user-joined', participant);

      const participants = Array.from(room.values());
      ack?.({ ok: true, isHost, participants });
      broadcastRoomState(cleanRoom);
    });

    socket.on('offer', ({ to, sdp }) => {
      if (to && sdp) {
        io.to(to).emit('offer', { from: socket.id, sdp });
      }
    });

    socket.on('answer', ({ to, sdp }) => {
      if (to && sdp) {
        io.to(to).emit('answer', { from: socket.id, sdp });
      }
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
      if (to && candidate) {
        io.to(to).emit('ice-candidate', { from: socket.id, candidate });
      }
    });

    socket.on('toggle-mute', ({ muted }) => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (room?.has(socket.id)) {
        room.get(socket.id).isMuted = Boolean(muted);
        broadcastRoomState(roomId);
      }
    });

    socket.on('toggle-camera', ({ cameraOff }) => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (room?.has(socket.id)) {
        room.get(socket.id).isCameraOff = Boolean(cameraOff);
        broadcastRoomState(roomId);
      }
    });

    socket.on('toggle-screen-share', ({ sharing }) => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (room?.has(socket.id)) {
        room.get(socket.id).isScreenSharing = Boolean(sharing);
        broadcastRoomState(roomId);
      }
    });

    socket.on('send-message', ({ text }) => {
      const roomId = socket.data.roomId;
      if (!roomId || !text) return;
      const msg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        senderId: socket.id,
        senderName: socket.data.userName || 'User',
        text: String(text).trim(),
        timestamp: new Date().toISOString()
      };
      io.to(roomId).emit('new-message', msg);
    });

    socket.on('end-meeting', ({ roomId }, ack) => {
      const targetRoom = roomId || socket.data.roomId;
      if (targetRoom) {
        io.to(targetRoom).emit('meeting-ended', { message: 'The teacher has ended this live class.' });
        rooms.delete(targetRoom);
      }
      ack?.({ ok: true });
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (room?.has(socket.id)) {
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

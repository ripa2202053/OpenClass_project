import { Server } from 'socket.io';

const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * Attaches the WebRTC Socket.io signaling server to the HTTP server.
 * Mirrors the standalone meeting-app signaling logic so the in-app
 * (embedded) OpenClass meeting UI can reuse the exact same protocol.
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
      isHost: p.isHost,
    }));
  }

  function broadcastRoomState(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    io.to(roomId).emit('room-state', participantList(room));
  }

  io.on('connection', (socket) => {
    socket.data.roomId = null;

    socket.on('join-room', ({ roomId, userId, userName } = {}, ack) => {
      const cleanRoom = String(roomId || '').trim().slice(0, 64);
      const cleanName = String(userName || 'Guest').trim().slice(0, 32) || 'Guest';

      if (!cleanRoom) {
        return ack?.({ ok: false, error: 'A room name is required.' });
      }

      const room = getRoom(cleanRoom);
      const participant = {
        socketId: socket.id,
        userId: userId || socket.id,
        userName: cleanName,
        muted: false,
        cameraOff: false,
        screenShare: false,
        raisedHand: false,
        isHost: room.size === 0,
      };

      socket.data.roomId = cleanRoom;
      socket.join(cleanRoom);
      room.set(socket.id, participant);

      const existing = participantList(room).filter((p) => p.socketId !== socket.id);
      socket.emit('existing-users', existing);
      socket.to(cleanRoom).emit('user-connected', participant);

      broadcastRoomState(cleanRoom);
      ack?.({ ok: true, isHost: participant.isHost, participants: participantList(room) });
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

    socket.on('raise-hand', ({ raisedHand }) => {
      const room = rooms.get(socket.data.roomId);
      if (room?.has(socket.id)) room.get(socket.id).raisedHand = Boolean(raisedHand);
      if (socket.data.roomId) broadcastRoomState(socket.data.roomId);
    });

    socket.on('send-message', ({ text } = {}) => {
      const roomId = socket.data.roomId;
      const cleanText = String(text || '').trim().slice(0, 1000);
      if (!roomId || !cleanText) return;
      const room = rooms.get(roomId);
      const sender = room?.get(socket.id);
      io.to(roomId).emit('new-message', {
        id: `${socket.id}-${Date.now()}`,
        roomId,
        fromSocketId: socket.id,
        senderName: sender?.userName || 'Guest',
        text: cleanText,
        timestamp: Date.now(),
      });
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

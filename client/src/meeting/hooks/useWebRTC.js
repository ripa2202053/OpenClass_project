import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { updateMeetingStatus } from '../../meetingService.js';

const SOCKET_URL = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
  ? 'http://127.0.0.1:5000'
  : 'https://openclass-project.onrender.com';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const SPEAK_THRESHOLD = 0.1;
const SPEAK_HOLD_MS = 1000;

/**
 * Manages the full WebRTC mesh conference lifecycle:
 * - local media acquisition (with graceful permission fallbacks)
 * - Socket.io signaling (join-room / existing-users / user-connected /
 *   offer / answer / ice-candidate / user-disconnected)
 * - peer connection lifecycle, track replacement for screen sharing
 * - active-speaker detection + local mic level metering
 * - complete cleanup on unmount / leave
 */
export default function useWebRTC() {
  const socketRef = useRef(null);
  const peersRef = useRef(new Map());
  const monitorsRef = useRef(new Map());
  const speakerCtxRef = useRef(null);
  const speakingIdRef = useRef(null);
  const micLevelRafRef = useRef(null);
  const selfSocketIdRef = useRef(null);
  const selfMetaRef = useRef({ userName: 'You', isHost: false });

  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const cameraTrackRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [roomId, setRoomId] = useState('');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [notes, setNotes] = useState([]);
  const [resources, setResources] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [speakingId, setSpeakingId] = useState(null);
  const [selfName, setSelfName] = useState('You');
  const [isHost, setIsHost] = useState(false);
  const [raisedHand, setRaisedHand] = useState(false);
  const [handRaisedToast, setHandRaisedToast] = useState(null);
  const [selfSocketId, setSelfSocketId] = useState(null);

  const publish = useCallback(() => {
    const map = new Map();
    const myId = selfSocketIdRef.current || socketRef.current?.id;

    peersRef.current.forEach((entry, socketId) => {
      if (!socketId || socketId === myId) return;
      if (entry && entry.meta) {
        map.set(socketId, {
          socketId,
          stream: entry.stream || null,
          ...entry.meta,
        });
      }
    });
    setRemoteStreams(Array.from(map.values()));
  }, []);

  const stopMonitor = useCallback((socketId) => {
    const stop = monitorsRef.current.get(socketId);
    if (stop) {
      try { stop(); } catch { /* ignore */ }
      monitorsRef.current.delete(socketId);
    }
  }, []);

  const cleanupPeer = useCallback(
    (socketId) => {
      const entry = peersRef.current.get(socketId);
      if (entry?.pc) {
        try { entry.pc.close(); } catch { /* ignore */ }
      }
      peersRef.current.delete(socketId);
      stopMonitor(socketId);
      setParticipants((prev) => prev.filter((p) => p.socketId !== socketId && p.id !== socketId));
      setRemoteStreams((prev) => prev.filter((p) => p.socketId !== socketId && p.id !== socketId));
      publish();
    },
    [publish, stopMonitor],
  );

  const ensureSpeakerCtx = () => {
    if (!speakerCtxRef.current) {
      speakerCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return speakerCtxRef.current;
  };

  const monitorRemoteAudio = useCallback((stream, socketId) => {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    try {
      const ctx = ensureSpeakerCtx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let lastSpoke = 0;
      const timer = setInterval(() => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length;
        if (avg / 255 > SPEAK_THRESHOLD) {
          if (speakingIdRef.current !== socketId) {
            speakingIdRef.current = socketId;
            setSpeakingId(socketId);
          }
          lastSpoke = Date.now();
        } else if (speakingIdRef.current === socketId && Date.now() - lastSpoke > SPEAK_HOLD_MS) {
          speakingIdRef.current = null;
          setSpeakingId(null);
        }
      }, 250);
      monitorsRef.current.set(socketId, () => {
        clearInterval(timer);
        try { src.disconnect(); analyser.disconnect(); } catch { /* ignore */ }
      });
    } catch (err) {
      console.warn('Audio monitor failed:', err);
    }
  }, []);

  const startMicMeter = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream || micLevelRafRef.current) return;
    try {
      const ctx = ensureSpeakerCtx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length;
        setMicLevel(Math.min(1, (avg / 255) * 1.6));
        micLevelRafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      console.warn('Mic meter failed:', err);
    }
  }, []);

  const connectToPeer = useCallback(
    async (user, initiate) => {
      const targetId = user.socketId;
      if (!targetId || peersRef.current.has(targetId)) return;

      const pc = new RTCPeerConnection(RTC_CONFIG);
      localStreamRef.current?.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current));

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.emit('ice-candidate', { to: targetId, candidate: event.candidate });
        }
      };

      pc.ontrack = (event) => {
        const entry = peersRef.current.get(targetId);
        if (!entry) return;
        entry.stream = event.streams[0] || new MediaStream([event.track]);
        if (entry.stream) monitorRemoteAudio(entry.stream, targetId);
        publish();
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          cleanupPeer(targetId);
        }
      };

      peersRef.current.set(targetId, { pc, meta: user, stream: null, pendingCandidates: [] });
      publish();

      if (initiate) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current?.emit('offer', { to: targetId, sdp: pc.localDescription });
        } catch (err) {
          console.warn('Failed to send offer:', err);
          cleanupPeer(targetId);
        }
      }
    },
    [cleanupPeer, monitorRemoteAudio, publish],
  );

  const flushPendingCandidates = useCallback(async (socketId) => {
    const entry = peersRef.current.get(socketId);
    if (!entry || !entry.pc || !Array.isArray(entry.pendingCandidates) || entry.pendingCandidates.length === 0) return;
    const queue = [...entry.pendingCandidates];
    entry.pendingCandidates = [];
    for (const cand of queue) {
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        console.warn('Error adding queued ICE candidate:', err);
      }
    }
  }, []);

  const replaceVideoTrackForAllPeers = useCallback((newTrack) => {
    peersRef.current.forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(newTrack);
    });
  }, []);

  const stopScreenShareInternal = useCallback(() => {
    const screen = screenStreamRef.current;
    screenStreamRef.current = null;
    const cameraTrack = cameraTrackRef.current;
    if (cameraTrack) {
      replaceVideoTrackForAllPeers(cameraTrack);
      const current = localStreamRef.current;
      if (current) {
        current.getVideoTracks().forEach((t) => current.removeTrack(t));
        if (cameraTrack.readyState === 'live') current.addTrack(cameraTrack);
      }
    }
    screen?.getTracks().forEach((t) => t.stop());
    setIsScreenSharing(false);
    socketRef.current?.emit('screen-share', { screenShare: false });
  }, [replaceVideoTrackForAllPeers]);

  const onMeetingEndedRef = useRef(null);
  const onKickedRef = useRef(null);

  const setupLocalStream = useCallback(async (options = { audio: true, video: true }) => {
    setError(null);
    let stream = null;
    try {
      const constraints = {
        video: options?.video !== false,
        audio: options?.audio !== false,
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.warn('Camera+mic unavailable, retrying with audio only:', err);
      setError(
        err.name === 'NotAllowedError'
          ? 'Camera/mic permission denied. You can still join to watch and chat.'
          : err.name === 'NotReadableError'
          ? 'Camera/mic in use by another application. Retrying with audio only...'
          : 'Could not access camera/mic. You can still join to watch and chat.',
      );
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (audioErr) {
        console.warn('Audio only also failed, continuing with no local stream:', audioErr);
        stream = new MediaStream();
      }
    }

    localStreamRef.current = stream;
    cameraTrackRef.current = stream?.getVideoTracks()[0] || null;
    if (stream) {
      setLocalStream(stream);
      startMicMeter();
    }
  }, [startMicMeter]);

  const leaveRoom = useCallback(() => {
    if (micLevelRafRef.current) cancelAnimationFrame(micLevelRafRef.current);
    micLevelRafRef.current = null;
    peersRef.current.forEach(({ pc }) => {
      try { pc.close(); } catch { /* ignore */ }
    });
    peersRef.current.clear();
    monitorsRef.current.forEach((stop) => {
      try { stop(); } catch { /* ignore */ }
    });
    monitorsRef.current.clear();
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    cameraTrackRef.current = null;
    if (speakerCtxRef.current) {
      try { speakerCtxRef.current.close(); } catch { /* ignore */ }
      speakerCtxRef.current = null;
    }
    socketRef.current?.disconnect();
    socketRef.current = null;
    setSelfSocketId(null);
    setLocalStream(null);
    setRemoteStreams([]);
    setMessages([]);
    setConnected(false);
    setRoomId('');
    setIsMuted(false);
    setIsCameraOff(false);
    setIsScreenSharing(false);
    setRaisedHand(false);
    setHandRaisedToast(null);
    speakingIdRef.current = null;
  }, []);

  const joinRoom = useCallback(async (roomIdOrOptions = { audio: true, video: true }, maybeOptions = {}) => {
    let options;
    if (typeof roomIdOrOptions === 'string') {
      options = { roomId: roomIdOrOptions, ...maybeOptions };
    } else {
      options = roomIdOrOptions || { audio: true, video: true };
    }

    const {
      roomId: rid,
      userName,
      token,
      isHost: hostRole = false,
      onMeetingEnded,
      onKicked,
      audio = true,
      video = true,
    } = options;

    onMeetingEndedRef.current = onMeetingEnded;
    onKickedRef.current = onKicked;
    if (socketRef.current) {
      leaveRoom();
    }
    setError(null);
    try {
      await setupLocalStream({ audio, video });
    } catch (err) {
      setError(err.message || 'Media permission denied');
      return;
    }
      const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        selfSocketIdRef.current = socket.id;
        setSelfSocketId(socket.id);
      });

      socket.on('existing-users', (users) => {
        if (Array.isArray(users)) {
          const myId = selfSocketIdRef.current || socketRef.current?.id;
          users.forEach((u) => {
            if (u && u.socketId && u.socketId !== myId) connectToPeer(u, true);
          });
        }
      });

      socket.on('user-joined', (user) => {
        const myId = selfSocketIdRef.current || socketRef.current?.id;
        if (user && user.socketId && user.socketId !== myId) {
          connectToPeer(user, false);
        }
      });

      socket.on('user-connected', (user) => {
        const myId = selfSocketIdRef.current || socketRef.current?.id;
        if (user && user.socketId && user.socketId !== myId) {
          connectToPeer(user, false);
        }
      });

      socket.on('offer', async ({ from, sdp }) => {
        const myId = selfSocketIdRef.current || socketRef.current?.id;
        if (!from || from === myId) return;
        try {
          let entry = peersRef.current.get(from);
          if (!entry) {
            await connectToPeer({ socketId: from, userName: from, isHost: false }, false);
            entry = peersRef.current.get(from);
          }
          const pc = entry?.pc;
          if (!pc) return;

          // Check for signaling collision (glare) and handle rollback if negotiating
          if (pc.signalingState !== 'stable') {
            console.warn(`[WebRTC] Offer collision detected on peer ${from}, state: ${pc.signalingState}`);
            try {
              await pc.setLocalDescription({ type: 'rollback' });
            } catch (e) {}
          }

          // 1. Set Remote Description first
          const offerDesc = sdp instanceof RTCSessionDescription ? sdp : new RTCSessionDescription(sdp);
          await pc.setRemoteDescription(offerDesc);

          // 2. Process queued ICE candidates
          await flushPendingCandidates(from);

          // 3. Create Answer and set Local Description ONLY if state is 'have-remote-offer'
          if (pc.signalingState === 'have-remote-offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // 4. Send answer back via socket
            socket.emit('answer', { to: from, sdp: pc.localDescription });
          } else {
            console.warn(`[WebRTC] Skipped answer creation because signalingState is: ${pc.signalingState}`);
          }
        } catch (err) {
          console.warn('[WebRTC] Offer handling failed safely caught:', err);
        }
      });

      socket.on('answer', async ({ from, sdp }) => {
        const myId = selfSocketIdRef.current || socketRef.current?.id;
        if (!from || from === myId) return;
        try {
          const entry = peersRef.current.get(from);
          const pc = entry?.pc;
          if (!pc) return;

          if (pc.signalingState === 'have-local-offer') {
            const answerDesc = sdp instanceof RTCSessionDescription ? sdp : new RTCSessionDescription(sdp);
            await pc.setRemoteDescription(answerDesc);
            await flushPendingCandidates(from);
          } else {
            console.warn(`[WebRTC] Skipped answer processing because signalingState is: ${pc.signalingState}`);
          }
        } catch (err) {
          console.warn('[WebRTC] Answer handling failed:', err);
        }
      });

      socket.on('ice-candidate', async ({ from, candidate }) => {
        const myId = selfSocketIdRef.current || socketRef.current?.id;
        if (!from || from === myId) return;
        try {
          const entry = peersRef.current.get(from);
          if (!entry || !entry.pc || !candidate) return;
          const pc = entry.pc;
          if (!pc.remoteDescription || !pc.remoteDescription.type) {
            if (!entry.pendingCandidates) entry.pendingCandidates = [];
            entry.pendingCandidates.push(candidate);
            return;
          }
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('ICE candidate rejected:', err);
        }
      });

      socket.on('user-disconnected', ({ socketId }) => {
        cleanupPeer(socketId);
      });

      socket.on('room-state', (list) => {
        if (!Array.isArray(list)) return;
        const myId = selfSocketIdRef.current || socketRef.current?.id;
        const uniqueMap = new Map();
        list.forEach((p) => {
          if (p && p.socketId && p.socketId !== myId) {
            uniqueMap.set(p.socketId, p);
          }
        });
        const deduplicatedList = Array.from(uniqueMap.values());
        setParticipants(deduplicatedList);

        deduplicatedList.forEach((p) => {
          const entry = peersRef.current.get(p.socketId);
          if (entry) {
            entry.meta = { ...entry.meta, ...p };
          }
        });
        publish();
      });

      socket.on('new-message', (msg) => {
        setMessages((prev) => [...prev, msg]);
      });

      socket.on('message-deleted', ({ messageId }) => {
        setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, isDeleted: true, text: 'Message deleted', message: 'Message deleted' } : m));
      });

      socket.on('note-added', (note) => {
        setNotes((prev) => [...prev, note]);
      });

      socket.on('resource-added', (res) => {
        setResources((prev) => [...prev, res]);
      });

      socket.on('hand-raised-toast', (data) => {
        setHandRaisedToast(data);
      });

      socket.on('hand-lowered', () => {
        setRaisedHand(false);
      });

      // Meeting Ended Event Listener
      socket.on('meeting-ended', (data) => {
        leaveRoom();
        if (typeof onMeetingEndedRef.current === 'function') {
          onMeetingEndedRef.current(data);
        }
      });

      // Participant Kicked Event Listener
      socket.on('participant-kicked', (data) => {
        const reason = data?.reason || 'You were removed from this live class by the teacher.';
        setError(reason);
        leaveRoom();
        if (typeof onKickedRef.current === 'function') {
          onKickedRef.current(reason);
        }
      });

    const isHostUser = Boolean(options.isHost || hostRole);
    socketRef.current.emit('join-room', { roomId: rid, userName, token, isHost: isHostUser }, (res) => {
      if (!res?.ok) {
        setError(res?.error || 'Failed to join room.');
        setConnected(false);
        return;
      }
      selfMetaRef.current = { userName, isHost: res.isHost };
      setSelfName(userName);
      setIsHost(res.isHost);
      setRoomId(rid);
      const myId = socketRef.current?.id || selfSocketIdRef.current;
      const rawParticipants = res.participants || [];
      const uniqueMap = new Map();
      rawParticipants.forEach((p) => {
        if (p && p.socketId && p.socketId !== myId) {
          uniqueMap.set(p.socketId, p);
        }
      });
      const participantList = Array.from(uniqueMap.values());
      setParticipants(participantList);
      setConnected(true);

      // Auto-connect to all participants who joined before this student (e.g. Sir/Teacher and earlier students)
      participantList.forEach((p) => {
        if (p.socketId && p.socketId !== myId) {
          connectToPeer(p, true);
        }
      });
    });
  }, [connectToPeer, cleanupPeer, publish, setupLocalStream, leaveRoom]);

  const endMeeting = useCallback((data = {}) => {
    return new Promise((resolve) => {
      const mId = data.meetingId;
      const cId = data.classroomId;
      if (mId) {
        updateMeetingStatus(mId, 'ended', cId).catch(() => {});
      }
      if (socketRef.current) {
        socketRef.current.emit('end-meeting', { roomId, ...data }, (res) => {
          leaveRoom();
          resolve(res || { ok: true });
        });
      } else {
        leaveRoom();
        resolve({ ok: true });
      }
    });
  }, [roomId, leaveRoom]);

  const kickParticipant = useCallback((targetSocketId) => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current) return reject(new Error('Socket disconnected'));
      socketRef.current.emit('kick-participant', { targetSocketId }, (res) => {
        if (res?.ok) {
          resolve(res);
        } else {
          reject(new Error(res?.error || 'Failed to kick participant'));
        }
      });
    });
  }, []);

  const lowerStudentHand = useCallback((targetSocketId) => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current) return reject(new Error('Socket disconnected'));
      socketRef.current.emit('teacher-lower-hand', { targetSocketId }, (res) => {
        if (res?.ok) {
          resolve(res);
        } else {
          reject(new Error(res?.error || 'Failed to lower hand'));
        }
      });
    });
  }, []);

  const deleteMessage = useCallback((messageId) => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current) return reject(new Error('Socket disconnected'));
      socketRef.current.emit('delete-message', { messageId }, (res) => {
        if (res?.ok) {
          resolve(res);
        } else {
          reject(new Error(res?.error || 'Failed to delete message'));
        }
      });
    });
  }, []);

  const toggleMute = useCallback(() => {
    const next = !isMuted;
    setIsMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next; });
    socketRef.current?.emit('toggle-mute', { muted: next });
  }, [isMuted]);

  const toggleCamera = useCallback(() => {
    const next = !isCameraOff;
    setIsCameraOff(next);
    const track = cameraTrackRef.current;
    if (track) track.enabled = !next;
    socketRef.current?.emit('toggle-camera', { cameraOff: next });
  }, [isCameraOff]);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      stopScreenShareInternal();
      return;
    }
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
      const screenTrack = screenStream.getVideoTracks()[0];
      screenTrack.onended = () => stopScreenShareInternal();
      screenStreamRef.current = screenStream;
      replaceVideoTrackForAllPeers(screenTrack);

      const current = localStreamRef.current;
      if (current) {
        current.getVideoTracks().forEach((t) => current.removeTrack(t));
        current.addTrack(screenTrack);
      }
      setIsScreenSharing(true);
      socketRef.current?.emit('screen-share', { screenShare: true });
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        console.warn('Screen share failed:', err);
      }
    }
  }, [isScreenSharing, replaceVideoTrackForAllPeers, stopScreenShareInternal]);

  const toggleRaiseHand = useCallback(() => {
    const next = !raisedHand;
    setRaisedHand(next);
    socketRef.current?.emit('raise-hand', { raisedHand: next });
  }, [raisedHand]);

  const sendMessage = useCallback((text, isQuestion = false) => {
    const clean = String(text || '').trim();
    if (!clean) return;
    socketRef.current?.emit('send-message', { text: clean, isQuestion: Boolean(isQuestion) });
  }, []);

  const addNote = useCallback((data = {}) => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current) return reject(new Error('Socket disconnected'));
      socketRef.current.emit('add-note', data, (res) => {
        if (res?.ok) resolve(res.note);
        else reject(new Error(res?.error || 'Failed to add note'));
      });
    });
  }, []);

  const addResource = useCallback((data = {}) => {
    return new Promise((resolve, reject) => {
      if (!socketRef.current) return reject(new Error('Socket disconnected'));
      socketRef.current.emit('add-resource', data, (res) => {
        if (res?.ok) resolve(res.resource);
        else reject(new Error(res?.error || 'Failed to add resource'));
      });
    });
  }, []);

  useEffect(() => {
    const onUnload = () => {
      peersRef.current.forEach(({ pc }) => {
        try { pc.close(); } catch { /* ignore */ }
      });
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      socketRef.current?.disconnect();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      if (micLevelRafRef.current) cancelAnimationFrame(micLevelRafRef.current);
      leaveRoom();
    };
  }, [leaveRoom]);

  return {
    connected,
    error,
    roomId,
    localStream,
    remoteStreams,
    participants,
    messages,
    notes,
    resources,
    isMuted,
    isCameraOff,
    isScreenSharing,
    micLevel,
    speakingId,
    selfName,
    isHost,
    raisedHand,
    handRaisedToast,
    selfSocketId,
    joinRoom,
    leaveRoom,
    endMeeting,
    kickParticipant,
    lowerStudentHand,
    deleteMessage,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleRaiseHand,
    sendMessage,
    addNote,
    addResource,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

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
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [speakingId, setSpeakingId] = useState(null);
  const [selfName, setSelfName] = useState('You');
  const [isHost, setIsHost] = useState(false);
  const [raisedHand, setRaisedHand] = useState(false);
  const [selfSocketId, setSelfSocketId] = useState(null);

  const publish = useCallback(() => {
    const list = [];
    peersRef.current.forEach((entry, socketId) => {
      if (entry.stream && entry.meta) {
        list.push({ socketId, stream: entry.stream, ...entry.meta });
      }
    });
    setRemoteStreams(list);
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
      if (peersRef.current.has(targetId)) return;

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

      peersRef.current.set(targetId, { pc, meta: user, stream: null });

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

  const joinRoom = useCallback(async ({ roomId: rid, userName }) => {
    setError(null);

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      console.warn('Camera+mic unavailable, retrying with audio only:', err);
      setError(
        err.name === 'NotAllowedError'
          ? 'Camera/mic permission denied. You can still join to watch and chat.'
          : 'Could not access camera/mic. You can still join to watch and chat.',
      );
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err2) {
        console.warn('Audio unavailable too:', err2);
        stream = null;
      }
    }

    localStreamRef.current = stream;
    cameraTrackRef.current = stream?.getVideoTracks()[0] || null;
    if (stream) {
      setLocalStream(stream);
      startMicMeter();
    }

    if (!socketRef.current) {
      const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        selfSocketIdRef.current = socket.id;
        setSelfSocketId(socket.id);
      });

      socket.on('existing-users', (users) => {
        users.forEach((u) => connectToPeer(u, true));
      });

      socket.on('user-connected', (user) => {
        connectToPeer(user, false);
      });

      socket.on('offer', async ({ from, sdp }) => {
        try {
          let entry = peersRef.current.get(from);
          if (!entry) {
            await connectToPeer({ socketId: from, userName: from, isHost: false }, false);
            entry = peersRef.current.get(from);
          }
          const pc = entry?.pc;
          if (!pc) return;
          await pc.setRemoteDescription(sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('answer', { to: from, sdp: pc.localDescription });
        } catch (err) {
          console.warn('Offer handling failed:', err);
        }
      });

      socket.on('answer', async ({ from, sdp }) => {
        try {
          const pc = peersRef.current.get(from)?.pc;
          if (!pc || !pc.currentLocalDescription) return;
          await pc.setRemoteDescription(sdp);
        } catch (err) {
          console.warn('Answer handling failed:', err);
        }
      });

      socket.on('ice-candidate', async ({ from, candidate }) => {
        try {
          const pc = peersRef.current.get(from)?.pc;
          if (!pc) return;
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn('ICE candidate rejected:', err);
        }
      });

      socket.on('user-disconnected', ({ socketId }) => {
        cleanupPeer(socketId);
      });

      socket.on('room-state', (list) => {
        setParticipants(list);
        list.forEach((p) => {
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
    }

    socketRef.current.emit('join-room', { roomId: rid, userName }, (res) => {
      if (!res?.ok) {
        setError(res?.error || 'Failed to join room.');
        setConnected(false);
        return;
      }
      selfMetaRef.current = { userName, isHost: res.isHost };
      setSelfName(userName);
      setIsHost(res.isHost);
      setRoomId(rid);
      setParticipants(res.participants || []);
      setConnected(true);
    });
  }, [connectToPeer, cleanupPeer, publish, startMicMeter]);

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
    setSpeakingId(null);
    speakingIdRef.current = null;
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

  const sendMessage = useCallback((text) => {
    const clean = String(text || '').trim();
    if (!clean) return;
    socketRef.current?.emit('send-message', { text: clean });
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
    isMuted,
    isCameraOff,
    isScreenSharing,
    micLevel,
    speakingId,
    selfName,
    isHost,
    raisedHand,
    selfSocketId,
    joinRoom,
    leaveRoom,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleRaiseHand,
    sendMessage,
  };
}

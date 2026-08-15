import React from 'react';
import VideoTile from './VideoTile';

export default function VideoGrid({
  remoteStreams = [],
  peers = [],
  participants = [],
  localStream = null,
  socket = null,
  currentUser = null,
  selfName = 'You',
  selfSocketId = null,
  isSelfMuted = false,
  isSelfCameraOff = false,
  isSelfPresenting = false,
  selfRaisedHand = false,
  isHost = false,
  speakingId = null,
  ...props
}) {
  // Consolidate remote source array
  const rawList = (remoteStreams && remoteStreams.length > 0)
    ? remoteStreams
    : ((peers && peers.length > 0) ? peers : participants);

  const currentSocketId = selfSocketId || socket?.id || '';
  const currentUserId = currentUser?.uid || '';

  // Deduplicate by unique socketId and safely exclude local self
  const remoteParticipants = Array.from(
    new Map(
      (rawList || [])
        .filter((p) => p && (p.socketId || p.id) && (p.socketId || p.id) !== currentSocketId && (p.socketId || p.id) !== 'self' && (!currentUserId || (p.userId || p.uid) !== currentUserId))
        .map((p) => [p.socketId || p.id, p])
    ).values()
  );

  const tiles = [
    {
      id: 'self',
      name: selfName,
      stream: localStream,
      isSelf: true,
      muted: isSelfMuted,
      cameraOff: isSelfCameraOff,
      presenting: isSelfPresenting,
      isSpeaking: speakingId === 'self',
      isHost,
      raisedHand: selfRaisedHand,
    },
    ...remoteParticipants.map((p, idx) => ({
      id: p.socketId || p.id || `remote-${idx}`,
      name: p.userName || p.name || (p.isHost ? 'Teacher' : 'Participant'),
      stream: p.stream || null,
      isSelf: false,
      muted: Boolean(p.muted || p.isMuted),
      cameraOff: Boolean(p.cameraOff || p.isCameraOff),
      presenting: Boolean(p.screenShare || p.isScreenSharing),
      isSpeaking: speakingId === (p.socketId || p.id),
      isHost: Boolean(p.isHost || p.role === 'teacher'),
      raisedHand: Boolean(p.raisedHand),
    })),
  ];

  const n = tiles.length;

  let gridStyle = {
    display: 'grid',
    gap: '20px',
    width: '100%',
    maxWidth: n === 1 ? '960px' : '1400px',
    margin: '0 auto',
    alignItems: 'center',
    justifyContent: 'center',
  };

  if (n === 1) {
    gridStyle.gridTemplateColumns = '1fr';
  } else if (n === 2) {
    gridStyle.gridTemplateColumns = 'repeat(auto-fit, minmax(420px, 1fr))';
  } else if (n <= 4) {
    gridStyle.gridTemplateColumns = 'repeat(auto-fit, minmax(360px, 1fr))';
  } else {
    gridStyle.gridTemplateColumns = 'repeat(auto-fit, minmax(300px, 1fr))';
  }

  return (
    <div
      style={{
        flex: 1,
        width: '100%',
        height: '100%',
        overflowY: 'auto',
        padding: '24px',
        backgroundColor: '#0B1120',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
      }}
    >
      <div style={gridStyle}>
        {tiles.map((t) => (
          <VideoTile key={t.id} {...t} />
        ))}
      </div>
    </div>
  );
}

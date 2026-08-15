import React from 'react';
import VideoTile from './VideoTile';

export default function VideoGrid({
  participants = [],
  peers = [],
  remoteStreams = [],
  socket = null,
  localStream = null,
  selfName = 'You',
  selfSocketId = null,
  isSelfMuted = false,
  isSelfCameraOff = false,
  isSelfPresenting = false,
  selfRaisedHand = false,
  isHost = false,
  speakingId = null,
}) {
  const rawPeers = (participants && participants.length > 0)
    ? participants
    : ((remoteStreams && remoteStreams.length > 0) ? remoteStreams : peers);

  const currentSocketId = selfSocketId || socket?.id || '';

  const remoteParticipants = Array.from(
    new Map(
      (rawPeers || [])
        .filter((p) => p && (p.socketId || p.id) && (p.socketId || p.id) !== currentSocketId && (p.socketId || p.id) !== 'self')
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
      isHost: Boolean(p.isHost),
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

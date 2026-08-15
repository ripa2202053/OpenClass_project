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
  // Identify local user identifiers
  const myUid = currentUser?.uid || currentUser?.id || '';
  const myName = currentUser?.displayName || currentUser?.name || '';
  const mySocketId = selfSocketId || socket?.id || '';

  // Consolidate remote source
  const sourceList = (remoteStreams && remoteStreams.length > 0)
    ? remoteStreams
    : (peers && peers.length > 0 ? peers : (participants || []));

  // Filter out local user by UID, socketId, AND isLocal flag
  const trueRemotePeers = Array.from(
    new Map(
      sourceList
        .filter(peer => {
          if (!peer) return false;
          if (peer.isLocal) return false;
          const sId = peer.socketId || peer.id;
          if (!sId || sId === 'self') return false;
          if (mySocketId && sId === mySocketId) return false;
          if (myUid && (peer.uid === myUid || peer.userId === myUid || peer.id === myUid)) return false;
          // Fallback: if there is only 1 participant in the room and it matches current user's name, ignore it
          if (sourceList.length === 1 && myName && (peer.name === myName || peer.userName === myName) && !peer.stream) return false;
          return true;
        })
        .map(peer => [peer.socketId || peer.id || peer.userId || peer.uid, peer])
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
    ...trueRemotePeers.map((p, idx) => ({
      id: p.socketId || p.id || p.userId || p.uid || `remote-${idx}`,
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

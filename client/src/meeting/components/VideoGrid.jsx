import VideoTile from './VideoTile';

export default function VideoGrid({
  participants = [],
  localStream,
  selfName = 'You',
  isSelfMuted = false,
  isSelfCameraOff = false,
  isSelfPresenting = false,
  selfRaisedHand = false,
  isHost = false,
  speakingId = null,
}) {
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
    ...participants.map((p) => ({
      id: p.socketId,
      name: p.userName || 'Guest',
      stream: p.stream,
      isSelf: false,
      muted: p.muted,
      cameraOff: p.cameraOff,
      presenting: p.screenShare,
      isSpeaking: speakingId === p.socketId,
      isHost: p.isHost,
      raisedHand: p.raisedHand,
    })),
  ];

  const n = tiles.length;
  const gridClass =
    n === 1
      ? 'grid-cols-1 max-w-4xl'
      : n === 2
        ? 'grid-cols-1 md:grid-cols-2'
        : n <= 4
          ? 'grid-cols-1 sm:grid-cols-2'
          : n <= 9
            ? 'grid-cols-2 lg:grid-cols-3'
            : 'grid-cols-2 lg:grid-cols-4';

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-4">
      <div className={`grid gap-3 mx-auto h-full ${gridClass}`}>
        {tiles.map((t) => (
          <VideoTile key={t.id} {...t} />
        ))}
      </div>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { MicOff, VideoOff, Hand, MonitorUp } from 'lucide-react';

function getInitials(name = '?') {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

export default function VideoTile({
  name,
  stream,
  isSelf = false,
  muted = false,
  cameraOff = false,
  presenting = false,
  isSpeaking = false,
  isHost = false,
  raisedHand = false,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const showVideo = Boolean(stream) && !cameraOff;

  return (
    <div
      className={`relative w-full aspect-video rounded-xl overflow-hidden bg-tile border ${
        isSpeaking ? 'speaking-ring border-emerald-400' : 'border-white/5'
      }`}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isSelf}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
          <div className="w-20 h-20 rounded-full bg-accent flex items-center justify-center text-white text-2xl font-semibold select-none">
            {getInitials(name)}
          </div>
        </div>
      )}

      {presenting && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-emerald-500/90 text-white text-[11px] font-semibold px-2 py-0.5 rounded-full">
          <MonitorUp className="w-3.5 h-3.5" /> Presenting
        </div>
      )}

      {muted && (
        <div className="absolute top-2 left-2 bg-red-500/90 text-white p-1.5 rounded-full">
          <MicOff className="w-3.5 h-3.5" />
        </div>
      )}

      {cameraOff && !isSelf && (
        <div className="absolute top-2 right-2 bg-black/50 text-white p-1.5 rounded-full">
          <VideoOff className="w-3.5 h-3.5" />
        </div>
      )}

      <div className="absolute bottom-0 inset-x-0 flex items-center gap-2 px-2.5 py-1.5 bg-gradient-to-t from-black/80 to-transparent">
        <span className="text-white text-sm font-medium truncate">
          {name}
          {isSelf ? ' (You)' : ''}
        </span>
        {isHost && (
          <span className="text-[10px] uppercase tracking-wide bg-emerald-500/80 text-white px-1.5 py-0.5 rounded shrink-0">
            Host
          </span>
        )}
        {raisedHand && <Hand className="w-4 h-4 text-yellow-400 shrink-0" />}
      </div>
    </div>
  );
}

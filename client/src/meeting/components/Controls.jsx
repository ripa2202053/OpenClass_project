import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  MonitorUp,
  MonitorStop,
  Users,
  MessageSquare,
  Hand,
  PhoneOff,
} from 'lucide-react';

function CtrlButton({ active, danger, title, onClick, children }) {
  const circleClass = danger
    ? 'bg-red-600 hover:bg-red-500'
    : active
      ? 'bg-slate-600 hover:bg-slate-500'
      : 'bg-slate-700/90 hover:bg-slate-600';

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 text-[11px] font-medium transition-colors ${danger ? 'text-red-300' : 'text-slate-300'}`}
    >
      <span
        className={`w-12 h-12 rounded-full flex items-center justify-center text-white shadow-lg transition-colors ${circleClass}`}
      >
        {children}
      </span>
    </button>
  );
}

export default function Controls({
  inline = false,
  isMuted,
  isCameraOff,
  isScreenSharing,
  micLevel = 0,
  raisedHand = false,
  participantsCount = 0,
  sidebarOpen = false,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onToggleRaiseHand,
  onToggleParticipants,
  onOpenChat,
  onLeave,
}) {
  return (
    <div className={inline ? 'absolute bottom-0 inset-x-0 z-30' : 'fixed bottom-0 inset-x-0 z-30'}>
      <div className="mx-auto max-w-5xl px-3 pb-4">
        <div className="flex items-center justify-center gap-2 sm:gap-3 bg-panel/95 backdrop-blur rounded-2xl px-4 py-2.5 shadow-2xl border border-white/10">
          <div className="relative flex flex-col items-center">
            <CtrlButton
              title={isMuted ? 'Unmute' : 'Mute'}
              active={isMuted}
              onClick={onToggleMute}
            >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </CtrlButton>
            <div className="mt-1 w-10 h-1 bg-white/10 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] duration-100 ${micLevel > 0.7 ? 'bg-red-400' : 'bg-emerald-400'}`}
                style={{ width: `${Math.round(micLevel * 100)}%` }}
              />
            </div>
          </div>

          <CtrlButton
            title={isCameraOff ? 'Turn camera on' : 'Turn camera off'}
            active={isCameraOff}
            onClick={onToggleCamera}
          >
            {isCameraOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
          </CtrlButton>

          <CtrlButton
            title={isScreenSharing ? 'Stop presenting' : 'Share screen'}
            active={isScreenSharing}
            onClick={onToggleScreenShare}
          >
            {isScreenSharing ? <MonitorStop className="w-5 h-5" /> : <MonitorUp className="w-5 h-5" />}
          </CtrlButton>

          <CtrlButton
            title={raisedHand ? 'Lower hand' : 'Raise hand'}
            active={raisedHand}
            onClick={onToggleRaiseHand}
          >
            <Hand className={`w-5 h-5 ${raisedHand ? 'text-yellow-300' : ''}`} />
          </CtrlButton>

          <div className="w-px h-10 bg-white/10 mx-1 hidden sm:block" />

          <CtrlButton
            title="Participants"
            active={sidebarOpen}
            onClick={onToggleParticipants}
          >
            <span className="relative">
              <Users className="w-5 h-5" />
              <span className="absolute -top-1.5 -right-2 bg-accent text-white text-[9px] font-bold rounded-full min-w-4 h-4 flex items-center justify-center px-0.5">
                {participantsCount}
              </span>
            </span>
          </CtrlButton>

          <CtrlButton title="Chat" active={sidebarOpen} onClick={onOpenChat}>
            <MessageSquare className="w-5 h-5" />
          </CtrlButton>

          <div className="w-px h-10 bg-white/10 mx-1 hidden sm:block" />

          <CtrlButton title="Leave meeting" danger onClick={onLeave}>
            <PhoneOff className="w-5 h-5" />
          </CtrlButton>
        </div>
      </div>
    </div>
  );
}

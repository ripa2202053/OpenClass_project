import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Copy, Check, X } from 'lucide-react';
import useWebRTC from '../hooks/useWebRTC';
import VideoGrid from './VideoGrid';
import Controls from './Controls';
import Sidebar from './Sidebar';

function formatTime(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export default function MeetingRoom({
  roomId,
  userName,
  token,
  meetingId,
  classroomId,
  title = 'Live Meeting',
  inviteLink,
  onClose,
  inline = false,
}) {
  const web = useWebRTC();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState('participants');
  const [seconds, setSeconds] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    web.joinRoom({
      roomId,
      userName,
      token,
      onMeetingEnded: () => {
        alert('The teacher has ended this live class.');
        onClose();
      },
      onKicked: (reason) => {
        alert(reason || 'You were removed from this live class by the teacher.');
        onClose();
      },
    });
    // Join once per mount; roomId/userName/token are stable for the room lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, userName, token]);

  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const copyInvite = () => {
    if (!inviteLink) return;
    navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const openParticipants = () => {
    setSidebarOpen(true);
    setSidebarTab('participants');
  };

  const openChat = () => {
    setSidebarOpen(true);
    setSidebarTab('chat');
  };

  const leave = () => {
    web.leaveRoom();
    onClose();
  };

  const handleEndClassForAll = async () => {
    if (!confirm('Are you sure you want to end this class for everyone?')) return;
    try {
      await web.endMeeting({ meetingId, classroomId });
    } catch (err) {
      alert(err.message || 'Failed to end meeting.');
    }
    onClose();
  };

  return (
    <div
      className={
        inline
          ? 'relative flex h-full w-full flex-col overflow-hidden rounded-xl bg-surface text-white'
          : 'fixed inset-0 z-[9999] flex flex-col overflow-hidden bg-surface text-white'
      }
      style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}
    >
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-panel/95 px-4 py-3 backdrop-blur">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 rounded-full bg-red-600 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            Live
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-white sm:text-base">{title}</h2>
            <p className="flex items-center gap-3 text-[11px] text-slate-400">
              <span className="flex items-center gap-1">
                <i className="material-icons" style={{ fontSize: 12 }}>schedule</i> {formatTime(seconds)}
              </span>
              <span className="flex items-center gap-1">
                <i className="material-icons" style={{ fontSize: 12 }}>people</i>{' '}
                {web.participants.length} Connected
              </span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {inviteLink && (
            <button
              type="button"
              onClick={copyInvite}
              className="flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied!' : 'Copy Invite'}
            </button>
          )}

          {web.isHost && (
            <button
              type="button"
              onClick={handleEndClassForAll}
              title="End Class for All"
              className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-red-500 shadow-md"
            >
              🔴 End Class for All
            </button>
          )}

          <button
            type="button"
            onClick={leave}
            title="Leave meeting"
            className="flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" /> Leave
          </button>
        </div>
      </header>

      {/* Real-time Hand Raised Toast Banner for Teacher Host */}
      {web.isHost && web.handRaisedToast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-amber-500 text-slate-950 text-xs font-bold px-4 py-2 rounded-xl shadow-2xl border border-amber-300 animate-bounce">
          <span>🙋 {web.handRaisedToast.userName} raised their hand</span>
        </div>
      )}

      {/* Body */}
      {!web.connected ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
          {web.error && (
            <div className="flex max-w-md items-center gap-2 text-center text-sm text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {web.error}
            </div>
          )}
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
          <p className="text-sm text-slate-400">Joining room…</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col pb-28">
            <VideoGrid
              participants={web.remoteStreams}
              localStream={web.localStream}
              selfName={web.selfName}
              isSelfMuted={web.isMuted}
              isSelfCameraOff={web.isCameraOff}
              isSelfPresenting={web.isScreenSharing}
              selfRaisedHand={web.raisedHand}
              isHost={web.isHost}
              speakingId={web.speakingId}
            />
          </main>

          {sidebarOpen && (
            <Sidebar
              participants={web.participants}
              messages={web.messages}
              notes={web.notes}
              resources={web.resources}
              selfSocketId={web.selfSocketId}
              isHost={web.isHost}
              classroomId={classroomId}
              meetingId={meetingId}
              onClose={() => setSidebarOpen(false)}
              onSendMessage={web.sendMessage}
              onKickParticipant={web.kickParticipant}
              onLowerStudentHand={web.lowerStudentHand}
              onDeleteMessage={web.deleteMessage}
              onAddNote={web.addNote}
              onAddResource={web.addResource}
            />
          )}
        </div>
      )}

      {web.connected && (
        <Controls
          inline={inline}
          isMuted={web.isMuted}
          isCameraOff={web.isCameraOff}
          isScreenSharing={web.isScreenSharing}
          micLevel={web.micLevel}
          raisedHand={web.raisedHand}
          participantsCount={web.participants.length}
          sidebarOpen={sidebarOpen}
          isHost={web.isHost}
          onToggleMute={web.toggleMute}
          onToggleCamera={web.toggleCamera}
          onToggleScreenShare={web.toggleScreenShare}
          onToggleRaiseHand={web.toggleRaiseHand}
          onToggleParticipants={openParticipants}
          onOpenChat={openChat}
          onLeave={leave}
          onEndClass={handleEndClassForAll}
        />
      )}
    </div>
  );
}

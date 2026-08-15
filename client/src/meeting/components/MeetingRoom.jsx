import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Copy, Check, X, Users, Clock, Radio, PhoneOff } from 'lucide-react';
import useWebRTC from '../hooks/useWebRTC';
import VideoGrid from './VideoGrid';
import Controls from './Controls';
import Sidebar from './Sidebar';
import { closeInAppMeeting } from '../index';

function formatTime(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export default function MeetingRoom({
  roomName,
  roomId,
  userName,
  token,
  isHost = false,
  meetingId,
  classroomId,
  title = 'Live Meeting',
  inviteLink,
  onLeave,
  onClose,
  inline = false,
}) {
  const web = useWebRTC();
  const activeRoomId = roomName || roomId;

  const uniqueRemotePeers = Array.from(
    new Map((web.remoteStreams || []).map((peer) => [peer.socketId, peer])).values()
  ).filter((peer) => peer && peer.socketId && peer.socketId !== web.selfSocketId);

  const connectedCount = uniqueRemotePeers.length + 1;

  const handleClose = () => {
    try { closeInAppMeeting(); } catch (e) {}
    if (typeof onLeave === 'function') onLeave();
    if (typeof onClose === 'function') onClose();
  };
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState('participants');
  const [seconds, setSeconds] = useState(0);
  const [copied, setCopied] = useState(false);
  const [dismissError, setDismissError] = useState(false);

  useEffect(() => {
    if (!activeRoomId) return;
    web.joinRoom({
      roomId: activeRoomId,
      userName,
      token,
      isHost,
      onMeetingEnded: (data) => {
        alert(data?.message || 'The teacher has ended this live class.');
        handleClose();
      },
      onKicked: (reason) => {
        alert(reason || 'You were removed from this live class by the teacher.');
        handleClose();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId, userName, token]);

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
    handleClose();
  };

  const handleEndClassForAll = async () => {
    if (!confirm('Are you sure you want to end this class for everyone?')) return;
    try {
      await web.endMeeting({ meetingId, classroomId });
    } catch (err) {
      alert(err.message || 'Failed to end meeting.');
    }
    handleClose();
  };

  return (
    <div
      style={{
        position: inline ? 'relative' : 'fixed',
        inset: 0,
        zIndex: 99999999,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        backgroundColor: '#0B1120',
        color: '#FFFFFF',
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Top Header Bar */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 24px',
          backgroundColor: '#172033',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          zIndex: 100,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '12px',
                backgroundColor: '#4F46E5',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: '800',
                fontSize: '14px',
                color: '#FFF',
                boxShadow: '0 4px 10px rgba(79, 70, 229, 0.4)',
              }}
            >
              OC
            </span>
            <span style={{ fontWeight: '800', fontSize: '16px', letterSpacing: '-0.02em', color: '#FFF' }}>
              OpenClass
            </span>
          </div>

          <div style={{ width: '1px', height: '24px', backgroundColor: 'rgba(255, 255, 255, 0.15)' }} />

          {/* LIVE Badge */}
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: '#10B981',
              color: '#FFF',
              fontSize: '11px',
              fontWeight: '800',
              padding: '3px 10px',
              borderRadius: '20px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#FFF' }} /> LIVE
          </span>

          <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            <h2 style={{ fontSize: '15px', fontWeight: '700', color: '#FFF', margin: 0 }}>{title}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '12px', color: '#94A3B8', marginTop: '2px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Clock size={14} color="#818CF8" /> {formatTime(seconds)}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Users size={14} color="#34D399" /> {connectedCount} Connected
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Radio size={14} color={web.connected ? '#34D399' : '#FBBF24'} />
                <span style={{ color: web.connected ? '#34D399' : '#FBBF24', fontWeight: '600' }}>
                  {web.connected ? 'Connected' : 'Connecting...'}
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Right Header Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
          {inviteLink && (
            <button
              type="button"
              onClick={copyInvite}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                color: '#E2E8F0',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '12px',
                padding: '8px 14px',
                fontSize: '12px',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {copied ? <Check size={14} color="#34D399" /> : <Copy size={14} color="#E2E8F0" />}
              <span>{copied ? 'Copied!' : 'Copy Link'}</span>
            </button>
          )}

          {web.isHost ? (
            <button
              type="button"
              onClick={handleEndClassForAll}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                backgroundColor: '#DC2626',
                color: '#FFF',
                border: 'none',
                borderRadius: '12px',
                padding: '8px 16px',
                fontSize: '12px',
                fontWeight: '700',
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(220, 38, 38, 0.4)',
              }}
            >
              <PhoneOff size={14} color="#FFF" />
              <span>End Class</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={leave}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                backgroundColor: 'rgba(239, 68, 68, 0.2)',
                color: '#F87171',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '12px',
                padding: '8px 14px',
                fontSize: '12px',
                fontWeight: '600',
                cursor: 'pointer',
              }}
            >
              <X size={14} color="#F87171" /> Leave
            </button>
          )}
        </div>
      </header>

      {/* Main Body */}
      {!web.connected && !dismissError ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '20px',
              padding: '36px',
              maxWidth: '440px',
              width: '100%',
              backgroundColor: '#172033',
              borderRadius: '24px',
              textAlign: 'center',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
            }}
          >
            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '18px',
                backgroundColor: 'rgba(79, 70, 229, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Loader2 size={28} color="#818CF8" style={{ animation: 'spin 1s linear infinite' }} />
            </div>

            <div>
              <h3 style={{ fontSize: '18px', fontWeight: '700', color: '#FFF', margin: 0 }}>Connecting to Live Meeting...</h3>
              <p style={{ fontSize: '13px', color: '#94A3B8', marginTop: '6px', margin: 0 }}>Setting up video stream and audio connection</p>
            </div>

            {web.error && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '14px',
                  borderRadius: '16px',
                  backgroundColor: 'rgba(245, 158, 11, 0.15)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                  color: '#FCD34D',
                  fontSize: '12px',
                  width: '100%',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '600' }}>
                  <AlertTriangle size={16} color="#F59E0B" />
                  <span>Media Access Note</span>
                </div>
                <p style={{ margin: 0 }}>{web.error}</p>
                <button
                  type="button"
                  onClick={() => setDismissError(true)}
                  style={{
                    marginTop: '6px',
                    padding: '6px 14px',
                    backgroundColor: '#F59E0B',
                    color: '#0F172A',
                    border: 'none',
                    borderRadius: '8px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                  }}
                >
                  Continue to Class
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flex: 1, position: 'relative', overflow: 'hidden', paddingBottom: '90px' }}>
          <main style={{ display: 'flex', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
            <VideoGrid
              participants={web.remoteStreams}
              localStream={web.localStream}
              selfName={web.selfName}
              selfSocketId={web.selfSocketId}
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

      {(web.connected || dismissError) && (
        <Controls
          inline={inline}
          isMuted={web.isMuted}
          isCameraOff={web.isCameraOff}
          isScreenSharing={web.isScreenSharing}
          micLevel={web.micLevel}
          raisedHand={web.raisedHand}
          participantsCount={connectedCount}
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

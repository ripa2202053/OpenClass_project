import React from 'react';
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

function CtrlButton({ active, danger, warning, label, title, onClick, children }) {
  let bgColor = 'rgba(255, 255, 255, 0.12)';
  if (danger) bgColor = '#EF4444';
  else if (warning) bgColor = '#F59E0B';
  else if (active) bgColor = '#4F46E5';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
      <button
        type="button"
        title={title || label}
        aria-label={title || label}
        onClick={onClick}
        style={{
          width: '46px',
          height: '46px',
          borderRadius: '14px',
          backgroundColor: bgColor,
          border: '1px solid rgba(255, 255, 255, 0.15)',
          color: '#FFFFFF',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          outline: 'none',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.06)')}
        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
      >
        {children}
      </button>
      <span style={{ fontSize: '11px', fontWeight: '500', color: '#CBD5E1', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </div>
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
  isHost = false,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onToggleRaiseHand,
  onToggleParticipants,
  onOpenChat,
  onLeave,
  onEndClass,
}) {
  return (
    <div
      style={{
        position: inline ? 'absolute' : 'fixed',
        bottom: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 999999999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 'auto',
        maxWidth: '95vw',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          padding: '12px 24px',
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          borderRadius: '24px',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(16px)',
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        {/* Mute / Unmute */}
        <CtrlButton
          label={isMuted ? 'Unmute' : 'Mute'}
          danger={isMuted}
          onClick={onToggleMute}
        >
          {isMuted ? <MicOff size={20} color="#FFF" /> : <Mic size={20} color="#FFF" />}
        </CtrlButton>

        {/* Camera On / Off */}
        <CtrlButton
          label={isCameraOff ? 'Cam Off' : 'Cam On'}
          danger={isCameraOff}
          onClick={onToggleCamera}
        >
          {isCameraOff ? <VideoOff size={20} color="#FFF" /> : <Video size={20} color="#FFF" />}
        </CtrlButton>

        {/* Screen Share */}
        <CtrlButton
          label={isScreenSharing ? 'Stop Share' : 'Share'}
          active={isScreenSharing}
          onClick={onToggleScreenShare}
        >
          {isScreenSharing ? <MonitorStop size={20} color="#10B981" /> : <MonitorUp size={20} color="#FFF" />}
        </CtrlButton>

        <div style={{ width: '1px', height: '32px', backgroundColor: 'rgba(255, 255, 255, 0.15)', margin: '0 4px' }} />

        {/* Raise Hand */}
        <CtrlButton
          label={raisedHand ? 'Hand Down' : 'Raise Hand'}
          warning={raisedHand}
          onClick={onToggleRaiseHand}
        >
          <Hand size={20} color={raisedHand ? '#0F172A' : '#FFF'} />
        </CtrlButton>

        {/* Participants */}
        <div style={{ position: 'relative' }}>
          <CtrlButton
            label="People"
            active={sidebarOpen}
            onClick={onToggleParticipants}
          >
            <Users size={20} color="#FFF" />
          </CtrlButton>
          {participantsCount > 0 && (
            <span
              style={{
                position: 'absolute',
                top: '-4px',
                right: '-4px',
                backgroundColor: '#4F46E5',
                color: '#FFF',
                fontSize: '10px',
                fontWeight: 'bold',
                borderRadius: '10px',
                padding: '2px 6px',
                boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
                pointerEvents: 'none',
              }}
            >
              {participantsCount}
            </span>
          )}
        </div>

        {/* Chat */}
        <CtrlButton label="Chat" active={sidebarOpen} onClick={onOpenChat}>
          <MessageSquare size={20} color="#FFF" />
        </CtrlButton>

        <div style={{ width: '1px', height: '32px', backgroundColor: 'rgba(255, 255, 255, 0.15)', margin: '0 4px' }} />

        {/* End Class / Leave */}
        {isHost && onEndClass ? (
          <button
            type="button"
            onClick={onEndClass}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: '#DC2626',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: '16px',
              padding: '12px 20px',
              fontSize: '13px',
              fontWeight: '700',
              cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(220, 38, 38, 0.4)',
              transition: 'all 0.2s ease',
              outline: 'none',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#EF4444')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#DC2626')}
          >
            <PhoneOff size={18} color="#FFF" />
            <span>End Class</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onLeave}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: 'rgba(239, 68, 68, 0.2)',
              color: '#F87171',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: '16px',
              padding: '12px 20px',
              fontSize: '13px',
              fontWeight: '700',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              outline: 'none',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.35)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.2)')}
          >
            <PhoneOff size={18} color="#F87171" />
            <span>Leave Class</span>
          </button>
        )}
      </div>
    </div>
  );
}

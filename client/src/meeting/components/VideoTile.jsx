import React, { useEffect, useRef } from 'react';
import { MicOff, VideoOff, Hand, MonitorUp, ShieldCheck } from 'lucide-react';

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
  name = 'Participant',
  stream = null,
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
    if (videoRef.current && stream && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const showVideo = Boolean(stream) && !cameraOff;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16/9',
        minHeight: '200px',
        backgroundColor: '#1E293B',
        borderRadius: '20px',
        overflow: 'hidden',
        border: isSpeaking ? '3px solid #10B981' : '1px solid rgba(255, 255, 255, 0.12)',
        boxShadow: isSpeaking ? '0 0 24px rgba(16, 185, 129, 0.4)' : '0 8px 24px rgba(0, 0, 0, 0.4)',
        transition: 'all 0.25s ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {showVideo ? (
        <video
          ref={(el) => {
            videoRef.current = el;
            if (el && stream && el.srcObject !== stream) {
              el.srcObject = stream;
            }
          }}
          autoPlay
          playsInline
          muted={isSelf}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: '20px',
          }}
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            background: 'linear-gradient(135deg, #1E293B 0%, #0F172A 100%)',
            padding: '16px',
          }}
        >
          <div
            style={{
              width: '72px',
              height: '72px',
              borderRadius: '50%',
              backgroundColor: isHost ? '#4F46E5' : '#2563EB',
              border: '3px solid rgba(255, 255, 255, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '22px',
              fontWeight: 'bold',
              color: '#FFFFFF',
              boxShadow: '0 8px 20px rgba(0, 0, 0, 0.3)',
              userSelect: 'none',
            }}
          >
            {getInitials(name)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
            <span style={{ fontSize: '14px', fontWeight: '600', color: '#F8FAFC' }}>
              {name} {isSelf ? '(You)' : ''}
            </span>
            <span style={{ fontSize: '12px', color: '#94A3B8', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <VideoOff size={14} color="#94A3B8" /> Camera Off
            </span>
          </div>
        </div>
      )}

      {/* Screen Share Pill */}
      {presenting && (
        <div
          style={{
            position: 'absolute',
            top: '12px',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: 'rgba(16, 185, 129, 0.95)',
            color: '#FFFFFF',
            fontSize: '11px',
            fontWeight: 'bold',
            padding: '4px 12px',
            borderRadius: '20px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 10,
          }}
        >
          <MonitorUp size={14} color="#FFF" /> Presenting Screen
        </div>
      )}

      {/* Muted Indicator Top Left */}
      {muted && (
        <div
          style={{
            position: 'absolute',
            top: '12px',
            left: '12px',
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            backgroundColor: 'rgba(239, 68, 68, 0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
            zIndex: 10,
          }}
          title="Microphone muted"
        >
          <MicOff size={16} color="#FFF" />
        </div>
      )}

      {/* Raised Hand Top Right */}
      {raisedHand && (
        <div
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            backgroundColor: '#F59E0B',
            color: '#0F172A',
            fontSize: '11px',
            fontWeight: 'bold',
            padding: '4px 10px',
            borderRadius: '20px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 10,
          }}
        >
          <Hand size={14} color="#0F172A" /> Raised Hand
        </div>
      )}

      {/* Bottom Name overlay */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          background: 'linear-gradient(to top, rgba(15, 23, 42, 0.95) 0%, rgba(15, 23, 42, 0) 100%)',
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
          <span style={{ fontSize: '13px', fontWeight: '600', color: '#FFFFFF', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name} {isSelf ? '(You)' : ''}
          </span>
          {isHost && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '3px',
                backgroundColor: '#4F46E5',
                color: '#FFFFFF',
                fontSize: '10px',
                fontWeight: '800',
                padding: '2px 8px',
                borderRadius: '6px',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                flexShrink: 0,
              }}
            >
              <ShieldCheck size={12} color="#FFF" /> Teacher
            </span>
          )}
        </div>

        {isSpeaking && (
          <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#10B981', display: 'flex', alignItems: 'center', gap: '4px' }}>
            Speaking
          </span>
        )}
      </div>
    </div>
  );
}

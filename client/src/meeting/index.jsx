import { createRoot } from 'react-dom/client';
import MeetingRoom from './components/MeetingRoom';
import './meeting.css';

let root = null;
let hostEl = null;
let inlineMode = false;

export function isMeetingOpen() {
  return !!hostEl;
}

/**
 * Mounts the embedded WebRTC meeting UI inside the current page (no new
 * tabs / external URLs). Renders the React MeetingRoom component either
 * into a fullscreen overlay appended to <body> (default) or, when
 * `container` + `inline` are provided, into an existing DOM container so
 * the meeting lives inside the SPA's workspace (e.g. classroom detail).
 */
export function openInAppMeeting({ roomName, userName, title, inviteLink, onClosed, container, inline } = {}) {
  if (hostEl) return;

  inlineMode = !!inline;

  if (inlineMode && container) {
    hostEl = container;
    container.style.display = 'block';
  } else {
    hostEl = document.createElement('div');
    hostEl.id = 'openclass-meeting-host';
    document.body.appendChild(hostEl);
    document.body.style.overflow = 'hidden';
  }

  root = createRoot(hostEl);
  root.render(
    <MeetingRoom
      roomId={roomName}
      userName={userName}
      title={title}
      inviteLink={inviteLink}
      inline={inlineMode}
      onClose={() => {
        closeInAppMeeting();
        if (typeof onClosed === 'function') onClosed();
      }}
    />,
  );
}

export function closeInAppMeeting() {
  document.body.style.overflow = '';
  if (root) {
    try {
      root.unmount();
    } catch (err) {
      /* ignore */
    }
    root = null;
  }
  if (hostEl) {
    if (inlineMode) {
      hostEl.style.display = 'none';
    } else {
      hostEl.remove();
    }
    hostEl = null;
  }
  inlineMode = false;
}

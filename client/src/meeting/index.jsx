import React from 'react';
import { createRoot } from 'react-dom/client';
import MeetingRoom from './components/MeetingRoom.jsx';
import { recordMeetingLeave } from '../meetingService.js';

let meetingRoot = null;
let currentMeetingState = null;
let activeUserProfile = null;

export function isMeetingOpen() {
  return currentMeetingState !== null;
}

export function closeInAppMeeting() {
  if (currentMeetingState && currentMeetingState.meetingId && activeUserProfile) {
    recordMeetingLeave(currentMeetingState.meetingId, activeUserProfile, currentMeetingState.classroomId).catch(() => {});
  }
  if (meetingRoot) {
    try {
      meetingRoot.unmount();
    } catch (e) {
      console.warn('Meeting root unmount notice:', e);
    }
    meetingRoot = null;
  }
  const overlay = document.getElementById('inapp-meeting-overlay');
  if (overlay) {
    overlay.remove();
  }
  currentMeetingState = null;
}

export function openInAppMeeting(options = {}, userProfile = null) {
  activeUserProfile = userProfile;
  closeInAppMeeting();

  const roomName = options.roomName || options.roomId || 'default-room';
  const displayName = options.userName || userProfile?.displayName || userProfile?.name || 'User';
  const meetingId = options.meetingId || options.id || null;
  const classroomId = options.classroomId || null;
  const token = options.token || null;
  const title = options.title || 'OpenClass Live Meeting';
  const inviteLink = options.inviteLink || window.location.href;

  currentMeetingState = { roomName, meetingId, classroomId };

  let container = options.container;
  if (!container) {
    const overlay = document.createElement('div');
    overlay.id = 'inapp-meeting-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.zIndex = '99999999';
    overlay.style.background = '#0f172a';
    document.body.appendChild(overlay);
    container = overlay;
  }

  meetingRoot = createRoot(container);
  meetingRoot.render(
    <React.StrictMode>
      <MeetingRoom
        roomName={roomName}
        userName={displayName}
        token={token}
        isHost={Boolean(options.isHost)}
        meetingId={meetingId}
        classroomId={classroomId}
        title={title}
        inviteLink={inviteLink}
        onLeave={() => {
          closeInAppMeeting();
          if (typeof options.onClosed === 'function') options.onClosed();
        }}
      />
    </React.StrictMode>
  );
}

export default function MeetingAppHost() {
  return null;
}

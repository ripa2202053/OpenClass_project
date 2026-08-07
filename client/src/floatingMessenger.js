import {
  createPrivateChat,
  sendPrivateMessage,
  subscribePrivateMessages,
  subscribePresence,
  setTyping,
  subscribeTyping,
  markRead,
  subscribeReadReceipts
} from './chatService.js';
import { getAuth } from 'firebase/auth';

let currentUser = null;
let activeTargetUser = null;
let activeChatId = null;
let messagesUnsub = null;
let presenceUnsub = null;
let typingUnsub = null;
let typingTimeout = null;
let isMinimized = false;

/**
 * Initializes DOM containers for Floating Messenger & Toast Alerts
 */
export function initFloatingMessenger(user) {
  currentUser = user;
  ensureDOMContainers();
}

function ensureDOMContainers() {
  if (!document.getElementById('floating-messenger-box')) {
    const messengerHTML = `
      <div id="floating-messenger-box" class="floating-messenger-box hidden">
        <div class="floating-messenger-header" id="floating-header-click">
          <div class="floating-user-info">
            <div class="floating-avatar-wrap">
              <img id="floating-target-avatar" class="floating-avatar-img" src="https://via.placeholder.com/40" alt="Avatar" />
              <span id="floating-target-presence" class="presence-dot"></span>
            </div>
            <div class="floating-user-details">
              <div style="display:flex;align-items:center;">
                <span id="floating-target-name" class="floating-user-name">Chat</span>
                <span id="floating-target-role" class="floating-user-role-badge"></span>
              </div>
              <span id="floating-target-status" class="floating-user-status-text">Offline</span>
            </div>
          </div>
          <div class="floating-header-actions">
            <button id="floating-minimize-btn" class="floating-action-btn" title="Minimize">
              <i class="material-icons" style="font-size:18px;">remove</i>
            </button>
            <button id="floating-close-btn" class="floating-action-btn" title="Close">
              <i class="material-icons" style="font-size:18px;">close</i>
            </button>
          </div>
        </div>
        <div id="floating-messenger-body" class="floating-messenger-body">
          <div style="text-align:center;padding:20px;color:#94a3b8;font-size:12px;">Start a conversation...</div>
        </div>
        <div id="floating-typing-container" style="display:none;padding:0 16px 8px 16px;">
          <div class="floating-typing-wrapper">
            <div class="typing-dots">
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
            </div>
            <span id="floating-typing-text" style="font-size:11px;color:#38bdf8;">typing...</span>
          </div>
        </div>
        <div class="floating-messenger-footer">
          <div class="floating-input-wrap">
            <input type="text" id="floating-chat-input" class="floating-input" placeholder="Type a message..." />
          </div>
          <button id="floating-send-btn" class="floating-send-btn">
            <i class="material-icons" style="font-size:18px;">send</i>
          </button>
        </div>
      </div>
      <div id="chat-toast-container" class="chat-toast-container"></div>
    `;
    document.body.insertAdjacentHTML('beforeend', messengerHTML);
    attachEventListeners();
  }
}

function attachEventListeners() {
  const header = document.getElementById('floating-header-click');
  const minimizeBtn = document.getElementById('floating-minimize-btn');
  const closeBtn = document.getElementById('floating-close-btn');
  const sendBtn = document.getElementById('floating-send-btn');
  const input = document.getElementById('floating-chat-input');

  header?.addEventListener('click', (e) => {
    if (e.target.closest('.floating-action-btn')) return;
    toggleMinimize();
  });

  minimizeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMinimize();
  });

  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFloatingMessenger();
  });

  sendBtn?.addEventListener('click', () => handleSend());

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  });

  input?.addEventListener('input', () => {
    if (!activeChatId || !currentUser) return;
    setTyping(`private_${activeChatId}`, currentUser.uid, currentUser.displayName || 'User', true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (activeChatId && currentUser) {
        setTyping(`private_${activeChatId}`, currentUser.uid, currentUser.displayName || 'User', false);
      }
    }, 2000);
  });
}

export function toggleMinimize() {
  const box = document.getElementById('floating-messenger-box');
  const icon = document.querySelector('#floating-minimize-btn i');
  if (!box) return;
  isMinimized = !isMinimized;
  if (isMinimized) {
    box.classList.add('minimized');
    if (icon) icon.textContent = 'crop_square';
  } else {
    box.classList.remove('minimized');
    if (icon) icon.textContent = 'remove';
    if (activeChatId && currentUser) {
      markRead(`private_${activeChatId}`, currentUser.uid);
    }
  }
}

export async function openFloatingMessenger(targetUser) {
  if (!currentUser) currentUser = getAuth().currentUser;
  if (!currentUser) return;

  ensureDOMContainers();
  activeTargetUser = targetUser;
  isMinimized = false;

  const box = document.getElementById('floating-messenger-box');
  const avatarEl = document.getElementById('floating-target-avatar');
  const nameEl = document.getElementById('floating-target-name');
  const roleEl = document.getElementById('floating-target-role');
  const statusTextEl = document.getElementById('floating-target-status');
  const presenceDot = document.getElementById('floating-target-presence');
  const icon = document.querySelector('#floating-minimize-btn i');

  if (icon) icon.textContent = 'remove';
  box.classList.remove('hidden', 'minimized');

  avatarEl.src = targetUser.photoURL || targetUser.photo || 'https://via.placeholder.com/40';
  nameEl.textContent = targetUser.displayName || targetUser.name || 'User';

  const role = (targetUser.role || 'student').toLowerCase();
  roleEl.textContent = role === 'teacher' ? 'TEACHER' : 'STUDENT';
  roleEl.className = `floating-user-role-badge ${role}`;

  // Reset presence UI
  presenceDot.className = 'presence-dot';
  statusTextEl.textContent = 'Connecting...';

  // Subscribe to target user's presence (Online / Offline status)
  if (presenceUnsub) presenceUnsub();
  presenceUnsub = subscribePresence(targetUser.uid, (status) => {
    if (status.state === 'online') {
      presenceDot.className = 'presence-dot online';
      statusTextEl.textContent = 'Active now';
    } else {
      presenceDot.className = 'presence-dot';
      const lastSeenText = status.lastSeen ? `Last seen ${formatTime(status.lastSeen)}` : 'Offline';
      statusTextEl.textContent = lastSeenText;
    }
  });

  // Get or Create Private Chat document
  const chatRes = await createPrivateChat([currentUser.uid, targetUser.uid], targetUser.classroomId || 'global');
  activeChatId = chatRes.id;

  // Subscribe to typing status
  if (typingUnsub) typingUnsub();
  typingUnsub = subscribeTyping(`private_${activeChatId}`, currentUser.uid, (typingList) => {
    const typingContainer = document.getElementById('floating-typing-container');
    const typingText = document.getElementById('floating-typing-text');
    if (!typingContainer || !typingText) return;
    if (typingList.length > 0) {
      const name = targetUser.displayName ? targetUser.displayName.split(' ')[0] : 'Someone';
      typingText.textContent = `${name} is typing...`;
      typingContainer.style.display = 'block';
    } else {
      typingContainer.style.display = 'none';
    }
  });

  // Subscribe to real-time private messages
  if (messagesUnsub) messagesUnsub();
  const bodyEl = document.getElementById('floating-messenger-body');
  messagesUnsub = subscribePrivateMessages(activeChatId, (msgs) => {
    renderMessages(msgs);
    // Mark as read if messenger is open
    if (!isMinimized) {
      markRead(`private_${activeChatId}`, currentUser.uid);
    }
  });
}

export function closeFloatingMessenger() {
  const box = document.getElementById('floating-messenger-box');
  if (box) box.classList.add('hidden');
  if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
  if (presenceUnsub) { presenceUnsub(); presenceUnsub = null; }
  if (typingUnsub) { typingUnsub(); typingUnsub = null; }
  activeChatId = null;
  activeTargetUser = null;
}

async function handleSend() {
  const input = document.getElementById('floating-chat-input');
  if (!input || !activeChatId || !currentUser) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  setTyping(`private_${activeChatId}`, currentUser.uid, currentUser.displayName || 'User', false);
  await sendPrivateMessage(activeChatId, currentUser, text);
}

function renderMessages(msgs) {
  const bodyEl = document.getElementById('floating-messenger-body');
  if (!bodyEl) return;

  if (!msgs || msgs.length === 0) {
    bodyEl.innerHTML = `<div style="text-align:center;padding:24px;color:#94a3b8;font-size:12.5px;">No previous messages. Say Hi! 👋</div>`;
    return;
  }

  bodyEl.innerHTML = '';
  msgs.forEach((m, idx) => {
    const isSent = m.senderId === currentUser.uid;
    const msgDiv = document.createElement('div');
    msgDiv.className = `messenger-msg ${isSent ? 'sent' : 'received'}`;

    const timeStr = m.timestamp ? formatTime(m.timestamp.seconds ? m.timestamp.seconds * 1000 : m.timestamp) : 'Just now';

    let statusHtml = '';
    if (isSent) {
      if (idx === msgs.length - 1) {
        statusHtml = `<span class="messenger-msg-meta">${timeStr} <i class="material-icons receipt-icon seen" title="Seen">done_all</i></span>`;
      } else {
        statusHtml = `<span class="messenger-msg-meta">${timeStr} <i class="material-icons receipt-icon delivered" title="Delivered">done</i></span>`;
      }
    } else {
      statusHtml = `<span class="messenger-msg-meta">${timeStr}</span>`;
    }

    msgDiv.innerHTML = `
      <div class="messenger-bubble">${escapeHTML(m.text)}</div>
      ${statusHtml}
    `;
    bodyEl.appendChild(msgDiv);
  });

  bodyEl.scrollTop = bodyEl.scrollHeight;
}

/**
 * Toast Notification Alert pop-up in top-right
 */
export function showChatToastAlert(senderInfo, messageText, onReplyClick) {
  ensureDOMContainers();
  const container = document.getElementById('chat-toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'chat-toast';

  const avatar = senderInfo.photoURL || senderInfo.photo || 'https://via.placeholder.com/40';
  const name = senderInfo.displayName || senderInfo.name || 'User';

  toast.innerHTML = `
    <img class="chat-toast-avatar" src="${avatar}" alt="${escapeHTML(name)}" />
    <div class="chat-toast-content">
      <div class="chat-toast-title">
        <span>${escapeHTML(name)}</span>
        <span class="chat-toast-time">Just now</span>
      </div>
      <div class="chat-toast-body">${escapeHTML(messageText)}</div>
      <div class="chat-toast-action">
        <i class="material-icons" style="font-size:14px;">chat</i> Click to reply
      </div>
    </div>
  `;

  toast.addEventListener('click', () => {
    toast.remove();
    const chatTabBtn = document.querySelector('.nav-item[data-tab="chat"]');
    if (chatTabBtn) {
      chatTabBtn.click();
    }
    if (window.selectContactByUid && (senderInfo?.uid || senderInfo?.id)) {
      const uid = senderInfo.uid || senderInfo.id;
      setTimeout(() => window.selectContactByUid(uid), 300);
    }
    if (onReplyClick) onReplyClick();
  });

  container.appendChild(toast);

  // Auto remove toast after 6 seconds
  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(60px)';
      setTimeout(() => toast.remove(), 300);
    }
  }, 6000);
}

function formatTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

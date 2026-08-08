import {
  createPrivateChat,
  sendPrivateMessage,
  subscribePrivateMessages,
  subscribePresence,
  setTyping,
  subscribeTyping,
  markRead,
  sendFileMessage,
  sendPrivateFileMessage,
  toggleMessageReaction
} from './chatService.js';
import { sanitizeProfilePhotoUrl } from './userService.js';
import { subscribeAllUsers, displayRole } from './userService.js';
import { subscribeToUserClassrooms } from './classroomService.js';
import { getAuth } from 'firebase/auth';
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore';

let currentUser = null;
let allUsers = [];
let userClassrooms = [];
let selectedTargetUser = null;
let activeChatId = null;
let messagesUnsub = null;
let presenceUnsub = null;
let typingUnsub = null;
let typingTimeout = null;
let usersUnsub = null;
let classroomsUnsub = null;

function getCurrentUserRole() {
  const u = currentUser || window.currentUserProfile;
  if (u && u.role) return String(u.role).toLowerCase();
  try {
    const saved = localStorage.getItem('openclass_user_profile');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.role) return String(parsed.role).toLowerCase();
    }
  } catch (e) {}
  return 'student';
}

function getCurrentUser() {
  if (currentUser && currentUser.uid) return currentUser;
  if (window.currentUserProfile && window.currentUserProfile.uid) return window.currentUserProfile;
  try {
    const saved = localStorage.getItem('openclass_user_profile');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.uid) return parsed;
    }
  } catch (e) {}
  return getAuth().currentUser;
}

export function initMessengerTab(user) {
  if (user && user.role) {
    currentUser = user;
  } else if (window.currentUserProfile && window.currentUserProfile.role) {
    currentUser = window.currentUserProfile;
  } else if (user) {
    currentUser = user;
  } else {
    currentUser = getCurrentUser();
  }
  attachEventListeners();
  loadContactsList();
}

// Global exposure for inline HTML event handlers
if (typeof window !== 'undefined') {
  window.initMessengerTab = initMessengerTab;
  window.loadMessengerContacts = loadContactsList;
  window.selectContactByUid = selectContactByUid;
  window.handleMessengerSend = handleSend;

  window.toggleMessengerEmojiPopover = function(e) {
    if (e) e.stopPropagation();
    const pop = document.getElementById('messenger-emoji-popover');
    if (pop) {
      pop.style.display = pop.style.display === 'none' ? 'grid' : 'none';
    }
  };

  window.insertMessengerEmoji = function(emoji) {
    const input = document.getElementById('messenger-chat-input');
    if (input) {
      input.value += emoji;
      input.focus();
    }
    const pop = document.getElementById('messenger-emoji-popover');
    if (pop) pop.style.display = 'none';
  };

  window.handleMessengerImageUpload = async function(file) {
    if (!file) return;
    const myUser = getCurrentUser() || { uid: 'temp_user', displayName: 'User' };
    
    if (!activeChatId && selectedTargetUser) {
      const sorted = [myUser.uid, selectedTargetUser.uid].sort();
      activeChatId = `chat_${sorted[0]}_${sorted[1]}`;
    }

    if (!activeChatId && allUsers.length > 0) {
      selectContact(allUsers[0]);
      const sorted = [myUser.uid, allUsers[0].uid].sort();
      activeChatId = `chat_${sorted[0]}_${sorted[1]}`;
    }

    if (!activeChatId) {
      console.warn('handleMessengerImageUpload: activeChatId is null');
      return;
    }

    // Instant Optimistic Image Preview (0ms)
    const bodyEl = document.getElementById('messenger-messages-body');
    if (bodyEl) {
      if (bodyEl.children.length === 1 && (bodyEl.children[0].textContent.includes('No previous messages') || bodyEl.children[0].textContent.includes('Select a conversation'))) {
        bodyEl.innerHTML = '';
      }
      const tempReader = new FileReader();
      tempReader.onload = async (evt) => {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'messenger-msg sent';
        msgDiv.style.position = 'relative';
        msgDiv.innerHTML = `
          <div class="messenger-bubble">
            <img src="${evt.target.result}" style="max-width:240px;border-radius:12px;display:block;margin-bottom:4px;" />
          </div>
          <span class="messenger-msg-meta">Uploading... <i class="material-icons receipt-icon delivered">done</i></span>
        `;
        bodyEl.appendChild(msgDiv);
        bodyEl.scrollTop = bodyEl.scrollHeight;
      };
      tempReader.readAsDataURL(file);
    }

    try {
      await sendPrivateFileMessage(activeChatId, file, myUser, '');
    } catch (err) {
      console.error('Error uploading private image:', err);
    }
  };

  window.toggleMessengerReaction = async function(messageId, emoji) {
    const myUser = getCurrentUser();
    const myUid = myUser?.uid || getAuth().currentUser?.uid || 'temp_user';
    if (!activeChatId) return;

    // Optimistic reaction update directly on DOM (0ms)
    const msgElements = document.querySelectorAll('.messenger-msg');
    let targetMsgEl = null;
    if (messageId) {
      targetMsgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
    }
    if (!targetMsgEl && msgElements.length > 0) {
      targetMsgEl = msgElements[msgElements.length - 1];
    }

    if (targetMsgEl) {
      let pillsWrap = targetMsgEl.querySelector('.msg-reactions-wrap');
      if (!pillsWrap) {
        pillsWrap = document.createElement('div');
        pillsWrap.className = 'msg-reactions-wrap';
        pillsWrap.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;';
        targetMsgEl.appendChild(pillsWrap);
      }
      let pill = pillsWrap.querySelector(`[data-emoji="${emoji}"]`);
      if (pill) {
        let count = parseInt(pill.getAttribute('data-count') || '1', 10);
        count++;
        pill.setAttribute('data-count', count);
        pill.innerHTML = `${emoji} ${count}`;
      } else {
        pill = document.createElement('span');
        pill.className = 'msg-reaction-pill';
        pill.setAttribute('data-emoji', emoji);
        pill.setAttribute('data-count', '1');
        pill.innerHTML = `${emoji} 1`;
        pillsWrap.appendChild(pill);
      }
    }

    if (messageId && !String(messageId).startsWith('temp_')) {
      try {
        await toggleMessageReaction(activeChatId, messageId, emoji, myUid);
      } catch (err) {
        console.warn('Reaction update warning:', err);
      }
    }
  };
}

function attachEventListeners() {
  const searchInput = document.getElementById('messenger-search-input');
  const sendBtn = document.getElementById('messenger-send-btn');
  const chatInput = document.getElementById('messenger-chat-input');
  const imageBtn = document.getElementById('messenger-image-btn');
  const imageInput = document.getElementById('messenger-image-input');
  const fsBtn = document.getElementById('messenger-toggle-fullscreen');
  const emojiBtn = document.getElementById('messenger-emoji-btn');
  const emojiPopover = document.getElementById('messenger-emoji-popover');

  fsBtn?.addEventListener('click', () => {
    const container = document.querySelector('.messenger-tab-container');
    if (container) {
      container.classList.toggle('fullscreen');
      const isFS = container.classList.contains('fullscreen');
      fsBtn.innerHTML = `<i class="material-icons" style="font-size:18px;">${isFS ? 'fullscreen_exit' : 'fullscreen'}</i>`;
    }
  });

  document.addEventListener('click', () => {
    if (emojiPopover) emojiPopover.style.display = 'none';
  });

  searchInput?.addEventListener('input', (e) => {
    renderContactsList(e.target.value);
  });

  chatInput?.addEventListener('input', () => {
    const myUser = getCurrentUser();
    const myUid = myUser?.uid || 'temp_user';
    if (!activeChatId) return;
    setTyping(`private_${activeChatId}`, myUid, myUser?.displayName || 'User', true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (activeChatId) {
        setTyping(`private_${activeChatId}`, myUid, myUser?.displayName || 'User', false);
      }
    }, 2000);
  });
}

export async function loadContactsList() {
  const listEl = document.getElementById('messenger-contacts-list');
  if (!listEl) return;

  if (usersUnsub) usersUnsub();
  if (classroomsUnsub) classroomsUnsub();

  const myUser = getCurrentUser();
  const currentUid = myUser?.uid || getAuth().currentUser?.uid;
  const userRole = getCurrentUserRole();
  const isTeacher = userRole === 'teacher' || userRole === 'admin';

  // Update Search Input Placeholder dynamically for Teacher vs Student role
  const searchInput = document.getElementById('messenger-search-input');
  if (searchInput) {
    if (isTeacher) {
      searchInput.placeholder = 'Search student by name or student ID...';
    } else {
      searchInput.placeholder = 'Search course teacher or instructor...';
    }
  }

  // Load classrooms to identify enrolled course teachers for students
  if (!isTeacher && currentUid) {
    classroomsUnsub = subscribeToUserClassrooms(currentUid, 'student', (cls) => {
      userClassrooms = cls || [];
      renderContactsList();
    });
  }

  const handleUsersData = (users) => {
    allUsers = (users || []).filter(u => u.uid !== currentUid);
    renderContactsList();
  };

  // Direct fetch real database users
  try {
    const db = getFirestore();
    const snap = await getDocs(collection(db, 'users'));
    const initialUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    handleUsersData(initialUsers);
  } catch (e) {
    console.warn('getDocs fetch warning:', e);
  }

  // Real-time snapshot listener
  try {
    usersUnsub = subscribeAllUsers((users) => {
      handleUsersData(users);
    });
  } catch (err) {
    console.warn('subscribeAllUsers subscription warning:', err);
  }
}

function renderContactsList(filterText = '') {
  const listEl = document.getElementById('messenger-contacts-list');
  if (!listEl) return;

  listEl.innerHTML = '';
  const query = (filterText || '').toLowerCase();
  const myUser = getCurrentUser();
  const currentUid = myUser?.uid || getAuth().currentUser?.uid;
  const userRole = getCurrentUserRole();
  const isCurrentTeacher = userRole === 'teacher' || userRole === 'admin';

  const filtered = allUsers.filter(u => {
    const name = (u.displayName || u.name || '').toLowerCase();
    const role = (u.role || '').toLowerCase();
    const email = (u.email || '').toLowerCase();
    const studentId = (u.studentId || u.teacherId || '').toLowerCase();
    return name.includes(query) || role.includes(query) || email.includes(query) || studentId.includes(query);
  });

  const createItem = (u) => {
    const item = document.createElement('div');
    const isSelected = selectedTargetUser && selectedTargetUser.uid === u.uid;
    const isSelf = u.uid === currentUid;
    item.className = `messenger-contact-item ${isSelected ? 'active' : ''}`;

    const displayNameClean = u.displayName || u.name || 'User';
    const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayNameClean)}&background=3b82f6&color=fff&size=80`;
    const photoUrl = sanitizeProfilePhotoUrl(u.photoURL || u.photo || '', u) || fallbackAvatar;
    const roleStr = (u.role || 'student').toLowerCase();
    const roleBadgeText = roleStr === 'teacher' ? 'TEACHER' : 'STUDENT';
    const nameLabel = escapeHTML(displayNameClean) + (isSelf ? ' (You)' : '');

    item.innerHTML = `
      <div class="contact-avatar-wrap">
        <img class="contact-avatar-img" src="${photoUrl}" alt="" onerror="this.onerror=null;this.src='${fallbackAvatar}';" />
        <span class="presence-dot" id="presence-dot-${u.uid}"></span>
      </div>
      <div class="contact-info">
        <div class="contact-name-row">
          <span class="contact-name">${nameLabel}</span>
          <span class="contact-role-tag ${roleStr}">${roleBadgeText}</span>
        </div>
        <span class="contact-snippet">${escapeHTML(u.email || 'Click to message')}</span>
      </div>
    `;

    subscribePresence(u.uid, (status) => {
      const dot = item.querySelector(`#presence-dot-${u.uid}`);
      if (dot) {
        if (status.state === 'online') {
          dot.className = 'presence-dot online';
        } else {
          dot.className = 'presence-dot';
        }
      }
    });

    item.addEventListener('click', () => selectContact(u));
    return item;
  };

  if (isCurrentTeacher) {
    // TEACHER VIEW: Display All Registered Students First
    const studentsList = filtered.filter(u => (u.role || '').toLowerCase() !== 'teacher');
    const teachersList = filtered.filter(u => (u.role || '').toLowerCase() === 'teacher');

    if (studentsList.length > 0) {
      const header = document.createElement('div');
      header.className = 'messenger-section-title';
      header.innerHTML = `<i class="material-icons" style="font-size:14px;color:#34d399;">groups</i> Student Conversations`;
      listEl.appendChild(header);
      studentsList.forEach(s => listEl.appendChild(createItem(s)));
    }
    
    if (teachersList.length > 0) {
      const header = document.createElement('div');
      header.className = 'messenger-section-title';
      header.innerHTML = `<i class="material-icons" style="font-size:14px;color:#60a5fa;">school</i> Fellow Teachers`;
      listEl.appendChild(header);
      teachersList.forEach(t => listEl.appendChild(createItem(t)));
    }

    if (studentsList.length === 0 && teachersList.length === 0) {
      if (filtered.length > 0) {
        filtered.forEach(u => listEl.appendChild(createItem(u)));
      } else {
        listEl.innerHTML = `
          <div style="padding:24px;text-align:center;color:#94a3b8;font-size:12.5px;">
            No users found.
          </div>`;
      }
    }

    // Auto select first available contact if none selected
    if (!selectedTargetUser) {
      const firstTarget = studentsList[0] || teachersList[0] || filtered[0];
      if (firstTarget) {
        selectContact(firstTarget);
      }
    }
  } else {
    // STUDENT VIEW: Course Teachers & All Platform Teachers
    const enrolledTeacherUids = new Set(userClassrooms.map(c => c.createdBy).filter(Boolean));
    const courseTeachers = filtered.filter(u => (u.role || '').toLowerCase() === 'teacher' && enrolledTeacherUids.has(u.uid));
    const allTeachers = filtered.filter(u => (u.role || '').toLowerCase() === 'teacher');

    const displayTeachers = courseTeachers.length > 0 ? courseTeachers : allTeachers;

    if (displayTeachers.length > 0) {
      const header = document.createElement('div');
      header.className = 'messenger-section-title';
      header.innerHTML = `<i class="material-icons" style="font-size:14px;color:#60a5fa;">school</i> Course Teachers & Instructors`;
      listEl.appendChild(header);
      displayTeachers.forEach(t => listEl.appendChild(createItem(t)));
    } else if (filtered.length > 0) {
      filtered.forEach(u => listEl.appendChild(createItem(u)));
    } else {
      listEl.innerHTML = `
        <div style="padding:24px;text-align:center;color:#94a3b8;font-size:12.5px;">
          No teachers found in database.
        </div>`;
    }

    if (!selectedTargetUser) {
      const firstTarget = displayTeachers[0] || filtered[0];
      if (firstTarget) {
        selectContact(firstTarget);
      }
    }
  }
}

export async function selectContact(targetUser) {
  const myUser = getCurrentUser();
  if (!targetUser) return;

  selectedTargetUser = targetUser;
  renderContactsList(document.getElementById('messenger-search-input')?.value || '');

  const emptyState = document.getElementById('messenger-empty-state');
  const chatArea = document.getElementById('messenger-active-area');
  const headerAvatar = document.getElementById('messenger-header-avatar');
  const headerName = document.getElementById('messenger-header-name');
  const headerRole = document.getElementById('messenger-header-role');

  if (emptyState) emptyState.style.display = 'none';
  if (chatArea) chatArea.style.display = 'flex';

  const nameClean = targetUser.displayName || targetUser.name || 'User';
  const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(nameClean)}&background=3b82f6&color=fff&size=80`;

  if (headerAvatar) {
    headerAvatar.src = sanitizeProfilePhotoUrl(targetUser.photoURL || targetUser.photo || '', targetUser) || fallbackAvatar;
    headerAvatar.onerror = () => { headerAvatar.onerror = null; headerAvatar.src = fallbackAvatar; };
  }
  if (headerName) headerName.textContent = nameClean;

  const role = (targetUser.role || 'student').toLowerCase();
  if (headerRole) {
    headerRole.textContent = role === 'teacher' ? 'TEACHER' : 'STUDENT';
    headerRole.className = `floating-user-role-badge ${role}`;
  }

  // Calculate deterministic Chat ID synchronously in 0 milliseconds!
  const myUid = myUser?.uid || getAuth().currentUser?.uid || 'temp_user';
  const targetUid = targetUser.uid || 'target_user';
  const sortedIds = [myUid, targetUid].sort();
  activeChatId = `chat_${sortedIds[0]}_${sortedIds[1]}`;

  // Ensure document created in background
  createPrivateChat([myUid, targetUid], 'global').catch(() => {});

  // Subscribe to typing indicator
  if (typingUnsub) typingUnsub();
  typingUnsub = subscribeTyping(`private_${activeChatId}`, myUid, (typingList) => {
    const typingContainer = document.getElementById('messenger-typing-indicator');
    const typingText = document.getElementById('messenger-typing-text');
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
  messagesUnsub = subscribePrivateMessages(activeChatId, (msgs) => {
    renderMessages(msgs);
    markRead(`private_${activeChatId}`, myUid);
  });
}

async function handleSend() {
  const input = document.getElementById('messenger-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const myUser = getCurrentUser() || { uid: 'user_me', displayName: 'User' };
  const myUid = myUser.uid || 'user_me';

  // Compute activeChatId dynamically if null
  if (!activeChatId) {
    if (selectedTargetUser) {
      const targetUid = selectedTargetUser.uid;
      const sortedIds = [myUid, targetUid].sort();
      activeChatId = `chat_${sortedIds[0]}_${sortedIds[1]}`;
    } else if (allUsers.length > 0) {
      selectContact(allUsers[0]);
      const targetUid = allUsers[0].uid;
      const sortedIds = [myUid, targetUid].sort();
      activeChatId = `chat_${sortedIds[0]}_${sortedIds[1]}`;
    } else {
      activeChatId = `chat_${myUid}_global`;
    }
  }

  input.value = '';
  setTyping(`private_${activeChatId}`, myUid, myUser.displayName || 'User', false);

  // Instant Optimistic UI Feedback (0ms)
  const bodyEl = document.getElementById('messenger-messages-body');
  if (bodyEl) {
    if (bodyEl.children.length === 1 && (bodyEl.children[0].textContent.includes('No previous messages') || bodyEl.children[0].textContent.includes('Select a conversation'))) {
      bodyEl.innerHTML = '';
    }
    const tempId = `temp_${Date.now()}`;
    const msgDiv = document.createElement('div');
    msgDiv.className = 'messenger-msg sent';
    msgDiv.style.position = 'relative';
    msgDiv.setAttribute('data-msg-id', tempId);

    msgDiv.innerHTML = `
      <div class="messenger-bubble">${escapeHTML(text)}</div>
      <span class="messenger-msg-meta">Just now <i class="material-icons receipt-icon delivered">done</i></span>
    `;

    // Reaction Bar on optimistic sent bubble
    const reactionBar = document.createElement('div');
    reactionBar.className = 'msg-reaction-bar';
    ['❤️', '👍', '😮', '😢', '🔥', '😂'].forEach(emoji => {
      const btn = document.createElement('span');
      btn.textContent = emoji;
      btn.onclick = (e) => {
        e.stopPropagation();
        if (window.toggleMessengerReaction) {
          window.toggleMessengerReaction(tempId, emoji);
        }
      };
      reactionBar.appendChild(btn);
    });
    msgDiv.appendChild(reactionBar);

    bodyEl.appendChild(msgDiv);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  try {
    await sendPrivateMessage(activeChatId, myUser, text);
  } catch (err) {
    console.error('Error sending private message:', err);
  }
}

function renderMessages(msgs) {
  const bodyEl = document.getElementById('messenger-messages-body');
  if (!bodyEl) return;

  if (!msgs || msgs.length === 0) {
    bodyEl.innerHTML = `<div style="text-align:center;padding:32px;color:#94a3b8;font-size:13px;">No previous messages. Say hello! 👋</div>`;
    return;
  }

  const myUser = getCurrentUser();
  const myUid = myUser?.uid || getAuth().currentUser?.uid;
  bodyEl.innerHTML = '';
  msgs.forEach((m, idx) => {
    const isSent = m.senderId === myUid;
    const msgDiv = document.createElement('div');
    msgDiv.className = `messenger-msg ${isSent ? 'sent' : 'received'}`;
    msgDiv.style.position = 'relative';
    if (m.id) msgDiv.setAttribute('data-msg-id', m.id);

    const timeStr = m.timestamp ? formatTime(m.timestamp.seconds ? m.timestamp.seconds * 1000 : m.timestamp) : 'Just now';

    let contentHtml = escapeHTML(m.text);
    if (m.type === 'file' && m.fileUrl) {
      contentHtml = `<img src="${m.fileUrl}" style="max-width:240px;border-radius:12px;display:block;margin-bottom:4px;" /><br/>` + contentHtml;
    }

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
      <div class="messenger-bubble">${contentHtml}</div>
      ${statusHtml}
    `;

    // Hover Reaction Toolbar (Messenger / WhatsApp style)
    const reactionBar = document.createElement('div');
    reactionBar.className = 'msg-reaction-bar';
    ['❤️', '👍', '😮', '😢', '🔥', '😂'].forEach(emoji => {
      const btn = document.createElement('span');
      btn.textContent = emoji;
      btn.onclick = (e) => {
        e.stopPropagation();
        if (window.toggleMessengerReaction) {
          window.toggleMessengerReaction(m.id || `temp_${idx}`, emoji);
        }
      };
      reactionBar.appendChild(btn);
    });
    msgDiv.appendChild(reactionBar);

    // Existing Reaction Pills Counter
    if (m.reactions && Object.keys(m.reactions).length > 0) {
      const pillsContainer = document.createElement('div');
      pillsContainer.className = 'msg-reactions-wrap';
      pillsContainer.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:2px;';
      Object.entries(m.reactions).forEach(([emoji, userArray]) => {
        if (Array.isArray(userArray) && userArray.length > 0) {
          const pill = document.createElement('span');
          pill.className = 'msg-reaction-pill';
          pill.setAttribute('data-emoji', emoji);
          pill.setAttribute('data-count', String(userArray.length));
          pill.innerHTML = `${emoji} ${userArray.length}`;
          pill.onclick = (e) => {
            e.stopPropagation();
            if (window.toggleMessengerReaction) {
              window.toggleMessengerReaction(m.id || `temp_${idx}`, emoji);
            }
          };
          pillsContainer.appendChild(pill);
        }
      });
      msgDiv.appendChild(pillsContainer);
    }

    bodyEl.appendChild(msgDiv);
  });

  bodyEl.scrollTop = bodyEl.scrollHeight;
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

export async function selectContactByUid(targetUid) {
  if (!targetUid) return;
  let target = allUsers.find(u => u.uid === targetUid);
  if (!target) {
    try {
      const db = getFirestore();
      const snap = await getDocs(collection(db, 'users'));
      const found = snap.docs.find(d => d.id === targetUid);
      if (found) {
        target = { uid: found.id, ...found.data() };
      }
    } catch(e){}
  }
  if (target) {
    selectContact(target);
  }
}

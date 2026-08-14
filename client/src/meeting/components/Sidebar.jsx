import React, { useState, useEffect } from 'react';
import { Users, MessageSquare, HelpCircle, ClipboardList, MicOff, VideoOff, Hand, Crown, X, Send, UserMinus, Trash2, Download, FileText, Link, Plus } from 'lucide-react';
import { fetchWithAuth } from '../../utils/api';
import { exportAttendanceCSV } from '../../meetingService.js';

function initials(name = '?') {
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

export default function Sidebar({
  participants = [],
  messages = [],
  notes = [],
  resources = [],
  selfSocketId = null,
  isHost = false,
  classroomId = null,
  meetingId = null,
  onClose,
  onSendMessage,
  onKickParticipant,
  onLowerStudentHand,
  onDeleteMessage,
  onAddNote,
  onAddResource,
}) {
  const [tab, setTab] = useState('participants');
  const [text, setText] = useState('');
  const [isQuestion, setIsQuestion] = useState(false);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [loadingAttendance, setLoadingAttendance] = useState(false);

  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [showNoteForm, setShowNoteForm] = useState(false);

  const [resTitle, setResTitle] = useState('');
  const [resUrl, setResUrl] = useState('');
  const [resType, setResType] = useState('link');
  const [showResForm, setShowResForm] = useState(false);

  const sorted = [...participants].sort((a, b) => {
    if (a.isHost !== b.isHost) return Number(b.isHost) - Number(a.isHost);
    if (a.raisedHand !== b.raisedHand) return Number(b.raisedHand) - Number(a.raisedHand);
    if (a.raisedHand && b.raisedHand) return (a.raisedAt || 0) - (b.raisedAt || 0);
    return (a.userName || '').localeCompare(b.userName || '');
  });

  const raisedQueueMap = new Map();
  let queueCounter = 1;
  sorted.forEach((p) => {
    if (p.raisedHand && !p.isHost) {
      raisedQueueMap.set(p.socketId, queueCounter++);
    }
  });

  useEffect(() => {
    if (tab === 'attendance' && isHost && classroomId && meetingId) {
      setLoadingAttendance(true);
      fetchWithAuth(`/api/classrooms/${classroomId}/meetings/${meetingId}/attendance`)
        .then((res) => {
          if (res && Array.isArray(res.records)) {
            setAttendanceRecords(res.records);
          }
        })
        .catch((err) => console.warn('Could not fetch attendance:', err))
        .finally(() => setLoadingAttendance(false));
    }
  }, [tab, isHost, classroomId, meetingId]);

  const submit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSendMessage(text, isQuestion);
    setText('');
    setIsQuestion(false);
  };

  const handleCreateNote = (e) => {
    e.preventDefault();
    if (!noteTitle.trim()) return;
    onAddNote?.({ title: noteTitle, content: noteContent });
    setNoteTitle('');
    setNoteContent('');
    setShowNoteForm(false);
  };

  const handleCreateResource = (e) => {
    e.preventDefault();
    if (!resTitle.trim()) return;
    onAddResource?.({ title: resTitle, url: resUrl, fileType: resType });
    setResTitle('');
    setResUrl('');
    setShowResForm(false);
  };

  const handleExportCSV = async () => {
    if (!meetingId) {
      alert('Meeting details unavailable for CSV export.');
      return;
    }
    try {
      await exportAttendanceCSV(meetingId, classroomId, 'Live Class Session');
    } catch (err) {
      alert('Failed to export attendance CSV: ' + err.message);
    }
  };

  const filteredMessages = tab === 'questions' ? messages.filter((m) => m.isQuestion || m.type === 'question') : messages;

  return (
    <aside
      style={{
        width: '320px',
        maxWidth: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#172033',
        borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '-10px 0 30px rgba(0,0,0,0.5)',
        zIndex: 150,
        flexShrink: 0,
      }}
    >
      {/* Header Tabs */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        }}
      >
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto' }}>
          <button
            type="button"
            onClick={() => setTab('participants')}
            style={{
              padding: '6px 10px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: '600',
              backgroundColor: tab === 'participants' ? 'rgba(255,255,255,0.15)' : 'transparent',
              color: tab === 'participants' ? '#FFF' : '#94A3B8',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <Users size={14} color="#FFF" /> People ({participants.length})
          </button>

          <button
            type="button"
            onClick={() => setTab('chat')}
            style={{
              padding: '6px 10px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: '600',
              backgroundColor: tab === 'chat' ? 'rgba(255,255,255,0.15)' : 'transparent',
              color: tab === 'chat' ? '#FFF' : '#94A3B8',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <MessageSquare size={14} color="#FFF" /> Chat
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{
            backgroundColor: 'transparent',
            border: 'none',
            color: '#94A3B8',
            cursor: 'pointer',
            padding: '4px',
          }}
        >
          <X size={18} color="#94A3B8" />
        </button>
      </div>

      {/* People Tab */}
      {tab === 'participants' && (
        <ul style={{ flex: 1, overflowY: 'auto', padding: '12px', listStyle: 'none', margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {sorted.map((p) => {
            const queueNum = raisedQueueMap.get(p.socketId);
            return (
              <li
                key={p.socketId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '8px 12px',
                  borderRadius: '10px',
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  fontSize: '13px',
                }}
              >
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    backgroundColor: p.isHost ? '#4F46E5' : '#2563EB',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#FFF',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    flexShrink: 0,
                  }}
                >
                  {initials(p.userName)}
                </div>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '500', color: '#F8FAFC' }}>
                  {p.userName} {p.socketId === selfSocketId ? '(You)' : ''}
                </span>
                {p.isHost && <Crown size={16} color="#F59E0B" title="Teacher / Host" />}
                {p.raisedHand && (
                  <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#F59E0B', backgroundColor: 'rgba(245, 158, 11, 0.2)', padding: '2px 6px', borderRadius: '4px' }}>
                    ✋ #{queueNum || 1}
                  </span>
                )}
                {p.muted && <MicOff size={14} color="#EF4444" />}
                {p.cameraOff && <VideoOff size={14} color="#64748B" />}
              </li>
            );
          })}
        </ul>
      )}

      {/* Chat Tab */}
      {tab === 'chat' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {filteredMessages.length === 0 && (
              <p style={{ textAlign: 'center', fontSize: '12px', color: '#64748B', marginTop: '20px' }}>
                No messages yet. Send a message to class!
              </p>
            )}
            {filteredMessages.map((m) => (
              <div
                key={m.id}
                style={{
                  padding: '10px 12px',
                  borderRadius: '10px',
                  backgroundColor: 'rgba(255, 255, 255, 0.06)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#818CF8' }}>{m.senderName}</span>
                  <span style={{ fontSize: '10px', color: '#64748B' }}>
                    {new Date(m.timestamp || m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p style={{ fontSize: '13px', color: '#F8FAFC', margin: 0, wordBreak: 'break-word' }}>{m.message || m.text}</p>
              </div>
            ))}
          </div>

          <form onSubmit={submit} style={{ padding: '12px', borderTop: '1px solid rgba(255,255,255,0.1)', display: 'flex', gap: '8px' }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type a message..."
              style={{
                flex: 1,
                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '10px',
                padding: '8px 12px',
                fontSize: '12px',
                color: '#FFF',
                outline: 'none',
              }}
            />
            <button
              type="submit"
              style={{
                backgroundColor: '#4F46E5',
                color: '#FFF',
                border: 'none',
                borderRadius: '10px',
                padding: '8px 14px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Send size={16} color="#FFF" />
            </button>
          </form>
        </div>
      )}
    </aside>
  );
}

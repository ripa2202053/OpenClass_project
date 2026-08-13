import { useState, useEffect } from 'react';
import { Users, MessageSquare, HelpCircle, ClipboardList, MicOff, VideoOff, Hand, Crown, X, Send, UserMinus, Trash2, Download, FileText, Link, Plus } from 'lucide-react';
import { fetchWithAuth } from '../../utils/api';

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

  // Note form state
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [showNoteForm, setShowNoteForm] = useState(false);

  // Resource form state
  const [resTitle, setResTitle] = useState('');
  const [resUrl, setResUrl] = useState('');
  const [resType, setResType] = useState('link');
  const [showResForm, setShowResForm] = useState(false);

  // Participant List Sorting: Host first, then Raised Hands ordered by queue timestamp, then alphabetical
  const sorted = [...participants].sort((a, b) => {
    if (a.isHost !== b.isHost) return Number(b.isHost) - Number(a.isHost);
    if (a.raisedHand !== b.raisedHand) return Number(b.raisedHand) - Number(a.raisedHand);
    if (a.raisedHand && b.raisedHand) return (a.raisedAt || 0) - (b.raisedAt || 0);
    return (a.userName || '').localeCompare(b.userName || '');
  });

  // Calculate raised hand queue numbers
  const raisedQueueMap = new Map();
  let queueCounter = 1;
  sorted.forEach((p) => {
    if (p.raisedHand && !p.isHost) {
      raisedQueueMap.set(p.socketId, queueCounter++);
    }
  });

  // Fetch Attendance records when Attendance tab is active
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
    if (!classroomId || !meetingId) {
      alert('Classroom or Meeting details unavailable for CSV export.');
      return;
    }
    try {
      const csvData = await fetchWithAuth(`/api/classrooms/${classroomId}/meetings/${meetingId}/attendance?format=csv`);
      const blob = new Blob([csvData], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Attendance_${classroomId}_${meetingId}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      alert('Failed to export attendance CSV: ' + err.message);
    }
  };

  const tabBtn = (id, label) =>
    `flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
      tab === id ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
    }`;

  const filteredMessages = tab === 'questions' ? messages.filter((m) => m.isQuestion || m.type === 'question') : messages;

  return (
    <aside className="w-full md:w-80 shrink-0 h-full flex flex-col bg-panel border-l border-white/10">
      {/* Header Tabs */}
      <div className="flex items-center justify-between px-2 py-2 border-b border-white/10">
        <div className="flex gap-0.5 overflow-x-auto scrollbar-none">
          <button type="button" className={tabBtn('participants')} onClick={() => setTab('participants')} title="People">
            <Users className="w-3.5 h-3.5" /> People ({participants.length})
          </button>
          <button type="button" className={tabBtn('chat')} onClick={() => setTab('chat')} title="Chat">
            <MessageSquare className="w-3.5 h-3.5" /> Chat
          </button>
          <button type="button" className={tabBtn('questions')} onClick={() => setTab('questions')} title="Q&A Questions">
            <HelpCircle className="w-3.5 h-3.5 text-amber-400" /> Q&A
          </button>
          <button type="button" className={tabBtn('notes')} onClick={() => setTab('notes')} title="Notes">
            <FileText className="w-3.5 h-3.5 text-cyan-400" /> Notes
          </button>
          <button type="button" className={tabBtn('resources')} onClick={() => setTab('resources')} title="Resources">
            <Link className="w-3.5 h-3.5 text-purple-400" /> Resources
          </button>
          {isHost && (
            <button type="button" className={tabBtn('attendance')} onClick={() => setTab('attendance')} title="Attendance">
              <ClipboardList className="w-3.5 h-3.5 text-emerald-400" /> Attendance
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/10 shrink-0"
          aria-label="Close sidebar"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* People Tab */}
      {tab === 'participants' && (
        <ul className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
          {sorted.map((p) => {
            const queueNum = raisedQueueMap.get(p.socketId);
            return (
              <li key={p.socketId} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-white/5">
                <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center text-white text-xs font-semibold shrink-0 select-none">
                  {initials(p.userName)}
                </div>
                <span className="flex-1 truncate text-xs font-medium">
                  {p.userName}
                  {p.socketId === selfSocketId ? ' (You)' : ''}
                </span>
                {p.isHost && <Crown className="w-4 h-4 text-amber-400 shrink-0" title="Teacher / Host" />}
                {p.raisedHand && (
                  <span className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                    <Hand className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                    {queueNum ? `#${queueNum}` : ''}
                  </span>
                )}
                {p.muted && <MicOff className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                {p.cameraOff && <VideoOff className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
                {isHost && p.raisedHand && (
                  <button
                    type="button"
                    onClick={() => onLowerStudentHand?.(p.socketId)}
                    title="Lower Student Hand"
                    className="p-1 text-amber-400 hover:text-amber-300 rounded hover:bg-amber-500/20 transition-colors text-[10px] font-semibold"
                  >
                    Lower Hand
                  </button>
                )}
                {p.socketId !== selfSocketId && isHost && !p.isHost && (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Are you sure you want to remove ${p.userName} from this class?`)) {
                        onKickParticipant?.(p.socketId);
                      }
                    }}
                    title="Remove / Kick Student"
                    className="p-1 text-slate-400 hover:text-red-400 rounded hover:bg-white/10 transition-colors"
                  >
                    <UserMinus className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Chat & Q&A Tabs */}
      {(tab === 'chat' || tab === 'questions') && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2.5">
            {filteredMessages.length === 0 && (
              <p className="text-center text-xs text-slate-500 mt-10">
                {tab === 'questions' ? 'No questions asked yet.' : 'No messages yet. Say hello!'}
              </p>
            )}
            {filteredMessages.map((m) => (
              <div key={m.id} className="flex flex-col bg-white/5 p-2 rounded-lg relative group">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-accent">{m.senderName}</span>
                    {m.senderRole === 'teacher' && (
                      <span className="text-[9px] bg-amber-500/20 text-amber-300 px-1 py-0.2 rounded font-semibold">Teacher</span>
                    )}
                    {(m.isQuestion || m.type === 'question') && (
                      <span className="text-[9px] bg-amber-500/30 text-amber-200 px-1 py-0.2 rounded font-bold flex items-center gap-0.5">
                        <HelpCircle className="w-2.5 h-2.5" /> Question
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-slate-400">
                      {new Date(m.timestamp || m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {isHost && !m.isDeleted && (
                      <button
                        type="button"
                        onClick={() => onDeleteMessage?.(m.id)}
                        title="Delete Message"
                        className="text-slate-400 hover:text-red-400 p-0.5 rounded transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
                {m.isDeleted ? (
                  <p className="text-xs italic text-slate-500 mt-1">Message deleted</p>
                ) : (
                  <p className="text-xs text-slate-200 break-words mt-1">{m.message || m.text}</p>
                )}
              </div>
            ))}
          </div>

          <form onSubmit={submit} className="p-2.5 border-t border-white/10 flex flex-col gap-2 bg-panel/90">
            <div className="flex items-center justify-between text-xs text-slate-300">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isQuestion}
                  onChange={(e) => setIsQuestion(e.target.checked)}
                  className="rounded border-white/20 bg-white/10 text-amber-500 focus:ring-amber-500 w-3.5 h-3.5"
                />
                <span className="text-[11px] font-medium text-amber-300 flex items-center gap-1">
                  <HelpCircle className="w-3 h-3" /> Mark as Question
                </span>
              </label>
            </div>
            <div className="flex gap-2">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={isQuestion ? "Ask a question..." : "Send a message..."}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                type="submit"
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover rounded-lg text-white transition-colors flex items-center justify-center"
                aria-label="Send message"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Notes Tab */}
      {tab === 'notes' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-3 border-b border-white/10 flex items-center justify-between">
            <h4 className="text-xs font-bold text-slate-200">Class Notes</h4>
            {isHost && (
              <button
                type="button"
                onClick={() => setShowNoteForm(!showNoteForm)}
                className="flex items-center gap-1 px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-bold shadow transition-colors"
              >
                <Plus className="w-3 h-3" /> Add Note
              </button>
            )}
          </div>

          {showNoteForm && isHost && (
            <form onSubmit={handleCreateNote} className="p-3 bg-white/5 border-b border-white/10 flex flex-col gap-2">
              <input
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="Note Title"
                className="bg-black/30 border border-white/10 rounded px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
              <textarea
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                placeholder="Note content / details..."
                rows={2}
                className="bg-black/30 border border-white/10 rounded px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 resize-none"
              />
              <div className="flex justify-end gap-2 mt-1">
                <button type="button" onClick={() => setShowNoteForm(false)} className="px-2 py-1 text-[11px] text-slate-400 hover:text-white">
                  Cancel
                </button>
                <button type="submit" className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 rounded text-white text-[11px] font-bold">
                  Save Note
                </button>
              </div>
            </form>
          )}

          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
            {notes.length === 0 ? (
              <p className="text-center text-xs text-slate-500 mt-6">No class notes created yet.</p>
            ) : (
              notes.map((n) => (
                <div key={n.id} className="p-2.5 rounded-lg bg-white/5 border border-white/10">
                  <h5 className="text-xs font-bold text-cyan-300">{n.title}</h5>
                  {n.content && <p className="text-xs text-slate-300 mt-1 whitespace-pre-wrap">{n.content}</p>}
                  <p className="text-[10px] text-slate-500 mt-1.5">
                    {n.createdByName} • {new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Resources Tab */}
      {tab === 'resources' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-3 border-b border-white/10 flex items-center justify-between">
            <h4 className="text-xs font-bold text-slate-200">Class Resources</h4>
            {isHost && (
              <button
                type="button"
                onClick={() => setShowResForm(!showResForm)}
                className="flex items-center gap-1 px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-bold shadow transition-colors"
              >
                <Plus className="w-3 h-3" /> Add Link/File
              </button>
            )}
          </div>

          {showResForm && isHost && (
            <form onSubmit={handleCreateResource} className="p-3 bg-white/5 border-b border-white/10 flex flex-col gap-2">
              <input
                value={resTitle}
                onChange={(e) => setResTitle(e.target.value)}
                placeholder="Resource Title (e.g. Lecture Slides)"
                className="bg-black/30 border border-white/10 rounded px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <input
                value={resUrl}
                onChange={(e) => setResUrl(e.target.value)}
                placeholder="URL Link (https://...)"
                className="bg-black/30 border border-white/10 rounded px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <select
                value={resType}
                onChange={(e) => setResType(e.target.value)}
                className="bg-black/30 border border-white/10 rounded px-2.5 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-purple-500"
              >
                <option value="link">Website Link</option>
                <option value="pdf">PDF Document</option>
                <option value="slide">Presentation Slides</option>
              </select>
              <div className="flex justify-end gap-2 mt-1">
                <button type="button" onClick={() => setShowResForm(false)} className="px-2 py-1 text-[11px] text-slate-400 hover:text-white">
                  Cancel
                </button>
                <button type="submit" className="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded text-white text-[11px] font-bold">
                  Add Resource
                </button>
              </div>
            </form>
          )}

          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
            {resources.length === 0 ? (
              <p className="text-center text-xs text-slate-500 mt-6">No class resources added yet.</p>
            ) : (
              resources.map((r) => (
                <div key={r.id} className="p-2.5 rounded-lg bg-white/5 border border-white/10 flex items-start gap-2">
                  <Link className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <h5 className="text-xs font-bold text-purple-300 truncate">{r.title}</h5>
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer" className="text-[11px] text-accent hover:underline truncate block mt-0.5">
                        {r.url}
                      </a>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Attendance Tab (Teacher Only) */}
      {tab === 'attendance' && isHost && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-3 border-b border-white/10 flex items-center justify-between">
            <h4 className="text-xs font-bold text-slate-200">Live Attendance</h4>
            <button
              type="button"
              onClick={handleExportCSV}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold shadow transition-colors"
            >
              <Download className="w-3 h-3" /> Export CSV
            </button>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1.5">
            {loadingAttendance ? (
              <p className="text-center text-xs text-slate-400 mt-6">Loading attendance records...</p>
            ) : attendanceRecords.length === 0 ? (
              <p className="text-center text-xs text-slate-500 mt-6">No enrolled student attendance found.</p>
            ) : (
              attendanceRecords.map((r) => (
                <div key={r.studentUid} className="flex items-center justify-between p-2 rounded-lg bg-white/5 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-white truncate">{r.studentName}</p>
                    <p className="text-[10px] text-slate-400">
                      Join: {r.joinTime} | Leave: {r.leaveTime}
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                        r.status === 'Present' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
                      }`}
                    >
                      {r.status}
                    </span>
                    <p className="text-[10px] text-slate-400 font-medium">{r.durationFormatted}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

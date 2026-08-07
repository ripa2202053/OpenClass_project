import { useState } from 'react';
import { Users, MessageSquare, MicOff, VideoOff, Hand, Crown, X, Send } from 'lucide-react';

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
  selfSocketId = null,
  onClose,
  onSendMessage,
}) {
  const [tab, setTab] = useState('participants');
  const [text, setText] = useState('');

  const sorted = [...participants].sort((a, b) => Number(b.isHost) - Number(a.isHost));

  const submit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSendMessage(text);
    setText('');
  };

  const tabBtn = (id, label, count) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
      tab === id ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
    }`;

  return (
    <aside className="w-full md:w-80 shrink-0 h-full flex flex-col bg-panel border-l border-white/10">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/10">
        <div className="flex gap-1">
          <button type="button" className={tabBtn('participants', 'Participants')} onClick={() => setTab('participants')}>
            <Users className="w-4 h-4" /> People ({participants.length})
          </button>
          <button type="button" className={tabBtn('chat', 'Chat')} onClick={() => setTab('chat')}>
            <MessageSquare className="w-4 h-4" /> Chat
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/10"
          aria-label="Close sidebar"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {tab === 'participants' ? (
        <ul className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
          {sorted.map((p) => (
            <li key={p.socketId} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5">
              <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-white text-xs font-semibold shrink-0 select-none">
                {initials(p.userName)}
              </div>
              <span className="flex-1 truncate text-sm">
                {p.userName}
                {p.socketId === selfSocketId ? ' (You)' : ''}
              </span>
              {p.isHost && <Crown className="w-4 h-4 text-amber-400 shrink-0" />}
              {p.raisedHand && <Hand className="w-4 h-4 text-yellow-400 shrink-0" />}
              {p.muted && <MicOff className="w-4 h-4 text-red-400 shrink-0" />}
              {p.cameraOff && <VideoOff className="w-4 h-4 text-slate-500 shrink-0" />}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2.5">
            {messages.length === 0 && (
              <p className="text-center text-sm text-slate-500 mt-10">No messages yet. Say hello!</p>
            )}
            {messages.map((m) => (
              <div key={m.id} className="flex flex-col">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold text-accent">{m.senderName}</span>
                  <span className="text-[10px] text-slate-500">
                    {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="text-sm text-slate-200 break-words">{m.text}</p>
              </div>
            ))}
          </div>
          <form onSubmit={submit} className="p-3 border-t border-white/10 flex gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Send a message"
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              className="p-2 bg-accent hover:bg-accent-hover rounded-lg text-white transition-colors"
              aria-label="Send message"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </aside>
  );
}

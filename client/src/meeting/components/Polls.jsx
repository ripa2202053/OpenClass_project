import { useState } from 'react';
import { HelpCircle, CheckCircle2, BarChart2, Plus, X, Lock } from 'lucide-react';

export default function Polls({
  activePoll = null,
  isHost = false,
  onCreatePoll,
  onVotePoll,
  onClosePoll,
  onClose,
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedOption, setSelectedOption] = useState(null);

  const handleAddOption = () => {
    if (options.length < 5) {
      setOptions([...options, '']);
    }
  };

  const handleOptionChange = (idx, val) => {
    const next = [...options];
    next[idx] = val;
    setOptions(next);
  };

  const handleCreateSubmit = (e) => {
    e.preventDefault();
    const cleanQ = question.trim();
    const cleanOpts = options.map((o) => o.trim()).filter(Boolean);
    if (!cleanQ || cleanOpts.length < 2) {
      alert('Please enter a question and at least 2 options.');
      return;
    }
    onCreatePoll?.({ question: cleanQ, options: cleanOpts });
    setQuestion('');
    setOptions(['', '']);
    setShowCreateForm(false);
  };

  const handleVoteSubmit = (e) => {
    e.preventDefault();
    if (selectedOption === null || !activePoll) return;
    onVotePoll?.({ pollId: activePoll.id, optionIndex: selectedOption });
  };

  const totalVotes = activePoll?.totalVotes || 0;

  return (
    <div className="flex flex-col w-full h-full bg-panel border-l border-white/10 text-white">
      {/* Top Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-white/10">
        <div className="flex items-center gap-1.5 text-xs font-bold text-amber-400">
          <HelpCircle className="w-4 h-4" /> Live Poll & Quiz
        </div>
        <div className="flex items-center gap-1">
          {isHost && (
            <button
              type="button"
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition"
            >
              <Plus className="w-3.5 h-3.5" /> New Poll
            </button>
          )}
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-white rounded hover:bg-white/10">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Create Poll Form */}
      {showCreateForm && isHost && (
        <form onSubmit={handleCreateSubmit} className="p-3 bg-white/5 border-b border-white/10 flex flex-col gap-2.5">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Poll Question (e.g. What is the derivative of x²?)"
            className="bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
          <div className="space-y-1.5">
            {options.map((opt, i) => (
              <input
                key={i}
                value={opt}
                onChange={(e) => handleOptionChange(i, e.target.value)}
                placeholder={`Option ${String.fromCharCode(65 + i)}`}
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            ))}
          </div>
          <div className="flex items-center justify-between mt-1">
            {options.length < 5 && (
              <button type="button" onClick={handleAddOption} className="text-amber-400 text-[11px] font-semibold hover:underline">
                + Add Option
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              <button type="button" onClick={() => setShowCreateForm(false)} className="px-2 py-1 text-xs text-slate-400">
                Cancel
              </button>
              <button type="submit" className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded text-xs font-bold">
                Start Poll
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Active Poll Panel */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {!activePoll ? (
          <p className="text-center text-xs text-slate-500 mt-10">No active poll right now.</p>
        ) : (
          <div className="p-3 rounded-xl bg-white/5 border border-white/10 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase mb-1 ${activePoll.active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-500/20 text-slate-400'}`}>
                  {activePoll.active ? '🔴 Active Poll' : 'Closed'}
                </span>
                <h4 className="text-xs font-bold text-white">{activePoll.question}</h4>
              </div>
              {isHost && activePoll.active && (
                <button
                  type="button"
                  onClick={() => onClosePoll?.(activePoll.id)}
                  className="px-2 py-1 bg-red-600 hover:bg-red-500 text-white rounded text-[10px] font-bold shrink-0"
                >
                  <Lock className="w-3 h-3 inline mr-1" /> Close Poll
                </button>
              )}
            </div>

            {/* Options Voting / Results */}
            <form onSubmit={handleVoteSubmit} className="space-y-2">
              {activePoll.options.map((opt, idx) => {
                const count = activePoll.results?.[idx] || 0;
                const percent = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                const hasVoted = activePoll.userVotedOption !== undefined;

                return (
                  <label
                    key={idx}
                    className={`block relative p-2.5 rounded-lg border text-xs cursor-pointer transition overflow-hidden ${
                      selectedOption === idx ? 'border-amber-400 bg-amber-500/10' : 'border-white/10 bg-black/20 hover:bg-white/5'
                    }`}
                  >
                    {/* Background progress bar */}
                    <div
                      className="absolute left-0 top-0 bottom-0 bg-amber-500/20 transition-all duration-300 pointer-events-none"
                      style={{ width: `${percent}%` }}
                    />
                    <div className="relative z-10 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {!hasVoted && activePoll.active && !isHost ? (
                          <input
                            type="radio"
                            name="pollOpt"
                            checked={selectedOption === idx}
                            onChange={() => setSelectedOption(idx)}
                            className="text-amber-500 focus:ring-amber-500"
                          />
                        ) : (
                          <span className="font-bold text-amber-300">{String.fromCharCode(65 + idx)}.</span>
                        )}
                        <span className="text-slate-200">{opt}</span>
                      </div>
                      <span className="text-[11px] font-bold text-slate-400">
                        {count} ({percent}%)
                      </span>
                    </div>
                  </label>
                );
              })}

              {!isHost && activePoll.active && activePoll.userVotedOption === undefined && (
                <button
                  type="submit"
                  disabled={selectedOption === null}
                  className="w-full mt-2 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 text-xs font-bold rounded-lg transition"
                >
                  Submit Vote
                </button>
              )}
            </form>

            <div className="flex items-center justify-between text-[11px] text-slate-400 border-t border-white/10 pt-2">
              <span>Total Votes: {totalVotes}</span>
              {activePoll.userVotedOption !== undefined && (
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Vote Submitted
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

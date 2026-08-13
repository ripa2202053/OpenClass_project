import { useEffect, useRef, useState } from 'react';
import { Pencil, Eraser, Trash2, Type, Highlighting, ShieldAlert, Download, X } from 'lucide-react';

export default function Whiteboard({
  isHost = false,
  canStudentDraw = false,
  onDrawStroke,
  onClearBoard,
  onToggleStudentDraw,
  onClose,
}) {
  const canvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const [color, setColor] = useState('#3b82f6');
  const [brushSize, setBrushSize] = useState(3);
  const [tool, setTool] = useState('pencil'); // pencil | eraser | highlighter | text
  const [textInput, setTextInput] = useState('');
  const [textPos, setTextPos] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    canvas.width = parent.clientWidth || 800;
    canvas.height = parent.clientHeight || 500;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const startDrawing = (e) => {
    if (!isHost && !canStudentDraw) return;
    const pos = getPos(e);

    if (tool === 'text') {
      setTextPos(pos);
      return;
    }

    isDrawingRef.current = true;
    const ctx = canvasRef.current.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  };

  const draw = (e) => {
    if (!isDrawingRef.current || (!isHost && !canStudentDraw)) return;
    const pos = getPos(e);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const drawColor = tool === 'eraser' ? '#0f172a' : tool === 'highlighter' ? `${color}66` : color;
    const drawSize = tool === 'highlighter' ? brushSize * 4 : tool === 'eraser' ? brushSize * 3 : brushSize;

    ctx.strokeStyle = drawColor;
    ctx.lineWidth = drawSize;
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();

    onDrawStroke?.({
      x: pos.x / canvas.width,
      y: pos.y / canvas.height,
      color: drawColor,
      size: drawSize,
      tool,
    });
  };

  const stopDrawing = () => {
    isDrawingRef.current = false;
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    onClearBoard?.();
  };

  const handleAddTextSubmit = (e) => {
    e.preventDefault();
    if (!textInput.trim() || !textPos) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.font = `${brushSize * 5 + 12}px sans-serif`;
    ctx.fillText(textInput, textPos.x, textPos.y);

    onDrawStroke?.({
      type: 'text',
      text: textInput,
      x: textPos.x / canvas.width,
      y: textPos.y / canvas.height,
      color,
      size: brushSize,
    });

    setTextInput('');
    setTextPos(null);
  };

  return (
    <div className="relative flex flex-col w-full h-full bg-slate-900 overflow-hidden rounded-xl border border-white/10 shadow-2xl">
      {/* Top toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-950/90 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-cyan-400">🎨 Collaborative Whiteboard</span>
          {!isHost && !canStudentDraw && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 font-semibold">
              <ShieldAlert className="w-3 h-3" /> View Only
            </span>
          )}
        </div>

        {(isHost || canStudentDraw) && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTool('pencil')}
              className={`p-1.5 rounded text-xs font-semibold flex items-center gap-1 transition ${
                tool === 'pencil' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              <Pencil className="w-3.5 h-3.5" /> Draw
            </button>
            <button
              type="button"
              onClick={() => setTool('highlighter')}
              className={`p-1.5 rounded text-xs font-semibold flex items-center gap-1 transition ${
                tool === 'highlighter' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              <Highlighting className="w-3.5 h-3.5" /> Highlight
            </button>
            <button
              type="button"
              onClick={() => setTool('eraser')}
              className={`p-1.5 rounded text-xs font-semibold flex items-center gap-1 transition ${
                tool === 'eraser' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              <Eraser className="w-3.5 h-3.5" /> Erase
            </button>
            <button
              type="button"
              onClick={() => setTool('text')}
              className={`p-1.5 rounded text-xs font-semibold flex items-center gap-1 transition ${
                tool === 'text' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              <Type className="w-3.5 h-3.5" /> Text
            </button>

            {/* Colors */}
            <div className="flex items-center gap-1 ml-2 border-l border-white/10 pl-2">
              {['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#ffffff'].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-4 h-4 rounded-full border ${color === c ? 'ring-2 ring-white scale-110' : 'border-white/20'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>

            {/* Brush size */}
            <input
              type="range"
              min="1"
              max="10"
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="w-16 h-1 bg-white/20 rounded accent-cyan-400 ml-2"
              title="Brush Size"
            />

            {isHost && (
              <button
                type="button"
                onClick={handleClear}
                className="p-1.5 text-red-400 hover:text-red-300 rounded hover:bg-red-500/10 ml-2 transition"
                title="Clear Whiteboard"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 hover:text-white p-1 rounded hover:bg-white/10"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Canvas */}
      <div className="relative flex-1 w-full h-full bg-slate-950">
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          className="w-full h-full cursor-crosshair touch-none"
        />

        {/* Floating text input */}
        {textPos && (
          <form
            onSubmit={handleAddTextSubmit}
            className="absolute z-20 bg-slate-900 p-2 rounded border border-cyan-500/50 shadow-xl flex gap-1"
            style={{ left: textPos.x, top: textPos.y }}
          >
            <input
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Type annotation..."
              autoFocus
              className="bg-black/50 border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none"
            />
            <button type="submit" className="px-2 py-1 bg-cyan-600 rounded text-xs text-white font-bold">
              Add
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

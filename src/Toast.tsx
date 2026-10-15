export function Toast({ message, onUndo, onClose }: { message: string; onUndo?: () => void; onClose: () => void }) {
  return <div className="toast" role="status" aria-live="polite"><span>{message}</span>
    {onUndo && <><span aria-hidden="true">·</span><button className="link" onClick={onUndo}>Undo</button></>}
    <button className="icon-btn" aria-label="Dismiss notification" onClick={onClose}>Close</button>
  </div>
}

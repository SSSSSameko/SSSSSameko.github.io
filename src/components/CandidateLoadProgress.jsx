import { useEffect, useState } from 'react';

export default function CandidateLoadProgress({ progress, isLoading, onCancel }) {
  const percent = Math.round(Math.max(0, Math.min(100, Number(progress?.percent) || 0)));
  const message = progress?.message || '正在处理';
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!progress) return undefined;
    const timer = window.setTimeout(() => {
      setAnnouncement(`${message}，${percent}%`);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [message, percent, Boolean(progress)]);

  if (!progress) return null;
  return (
    <div className="v3-progress">
      <div className="v3-progress-copy">
        <span>{message}</span>
        <strong>{percent}%</strong>
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      {isLoading && (
        <button type="button" onClick={onCancel}>取消载入</button>
      )}
      <div
        className="v3-progress-track"
        role="progressbar"
        aria-label="候选载入进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${message}，${percent}%`}
      >
        <i style={{ '--progress-scale': percent / 100 }} />
      </div>
    </div>
  );
}

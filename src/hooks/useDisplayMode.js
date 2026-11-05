import { useEffect, useState } from 'react';

function readDisplayMode() {
  return {
    standalone: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
    fullscreen: Boolean(document.fullscreenElement),
    supported: Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen),
  };
}

export default function useDisplayMode() {
  const [mode, setMode] = useState(readDisplayMode);
  const [error, setError] = useState('');
  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)');
    const refresh = () => setMode(readDisplayMode());
    document.addEventListener('fullscreenchange', refresh);
    standalone.addEventListener('change', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      document.removeEventListener('fullscreenchange', refresh);
      standalone.removeEventListener('change', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);
  async function toggle() {
    setError('');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (mode.supported) await document.documentElement.requestFullscreen();
      else return false;
      setMode(readDisplayMode());
      return true;
    } catch {
      setError('浏览器未能进入全屏，可以按下面的步骤从主屏幕打开。');
      return false;
    }
  }
  return { ...mode, error, toggle };
}

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readApiResponse, requestApi } from '../lib/browserApi.js';
import { knownDrawCount } from '../lib/repostResponse.js';
import { isWeiboStatusReference } from '../lib/weiboStatus.js';

// A count belongs to one source, link, backend and credential snapshot.
export function useDrawCount({ source, statusUrl, apiBase, apiKey }) {
  const context = useMemo(() => ({ source, statusUrl, apiBase, apiKey }), [source, statusUrl, apiBase, apiKey]);
  const valid = source !== 'manual' && isWeiboStatusReference(statusUrl);
  const active = useRef({ context: null, controller: null, timer: null });
  const [state, setState] = useState({ context, count: null, status: 'idle' });

  const cancel = useCallback(() => {
    window.clearTimeout(active.current.timer);
    active.current.timer = null;
    active.current.controller?.abort();
    active.current.controller = null;
  }, []);

  const refreshDrawCount = useCallback(async () => {
    if (active.current.context !== context) return;
    cancel();
    if (!valid) {
      setState({ context, count: null, status: 'idle' });
      return;
    }
    const controller = new AbortController();
    active.current.controller = controller;
    const isCurrent = () => active.current.context === context && active.current.controller === controller;
    setState({ context, count: null, status: 'loading' });
    try {
      const response = await requestApi(
        `/api/weibo/draw-count?statusUrl=${encodeURIComponent(context.statusUrl)}`,
        { signal: controller.signal },
        context,
      );
      const data = await readApiResponse(response, '开奖记录服务');
      if (!data.ok) throw new Error('开奖次数查询失败');
      if (!isCurrent()) return;
      const count = knownDrawCount(data.drawCount);
      setState({ context, count, status: count === null ? 'unknown' : 'ready' });
    } catch {
      if (isCurrent()) setState({ context, count: null, status: 'error' });
    } finally {
      if (isCurrent()) active.current.controller = null;
    }
  }, [context, valid, cancel]);

  useLayoutEffect(() => {
    active.current.context = context;
    cancel();
    setState({ context, count: null, status: valid ? 'loading' : 'idle' });
    if (valid) {
      active.current.timer = window.setTimeout(() => {
        active.current.timer = null;
        void refreshDrawCount();
      }, 700);
    }
    return () => {
      active.current.context = null;
      cancel();
    };
  }, [context, valid, refreshDrawCount, cancel]);

  const acceptDrawCount = useCallback((value, {
    source: expectedSource = context.source,
    statusUrl: expectedUrl = context.statusUrl,
    idle = false,
  } = {}) => {
    const current = active.current.context;
    // Load operations may deliberately switch source/link before their response arrives.
    if (!current || current.source !== expectedSource || current.statusUrl !== expectedUrl
      || current.apiBase !== context.apiBase || current.apiKey !== context.apiKey) return false;
    cancel();
    const count = knownDrawCount(value);
    setState({ context: current, count, status: idle ? 'idle' : count === null ? 'unknown' : 'ready' });
    return true;
  }, [context, cancel]);

  return {
    drawCount: state.context === context ? state.count : null,
    drawCountStatus: state.context === context ? state.status : valid ? 'loading' : 'idle',
    refreshDrawCount,
    acceptDrawCount,
  };
}

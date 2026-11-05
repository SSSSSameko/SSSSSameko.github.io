import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readApiResponse, requestApi } from '../lib/browserApi.js';

// Health and account state belong to the same backend/credential snapshot.
// Each endpoint cancels its previous check, including response-body reads.
export function useBackendStatus({ apiBase, apiKey, onNotice }) {
  const [apiHealth, setApiHealth] = useState('checking');
  const [apiHealthDetail, setApiHealthDetail] = useState('');
  const [apiAuthRequired, setApiAuthRequired] = useState(false);
  const [cookieHealth, setCookieHealth] = useState('checking');
  const [cookieInfo, setCookieInfo] = useState({ hasCookie: false, cookieCount: 0 });
  const requests = useRef({ health: null, cookie: null });
  const notice = useRef(onNotice);
  useLayoutEffect(() => {
    notice.current = onNotice;
  });

  useLayoutEffect(() => {
    setApiHealth('checking');
    setApiHealthDetail('');
    setApiAuthRequired(false);
    setCookieHealth('checking');
    setCookieInfo({ hasCookie: false, cookieCount: 0 });
    return () => {
      for (const request of Object.values(requests.current)) request?.abort();
      requests.current = { health: null, cookie: null };
    };
  }, [apiBase, apiKey]);

  const loadCookieStatus = useCallback(
    async (check = false, requestBase = apiBase) => {
      requests.current.cookie?.abort();
      const controller = new AbortController();
      requests.current.cookie = controller;
      setCookieHealth('checking');
      try {
        const response = await requestApi(
          `/api/weibo/cookie-status${check ? '?check=1' : ''}`,
          {
            signal: controller.signal,
          },
          { apiBase: requestBase, apiKey },
        );
        const data = await readApiResponse(response, 'Cookie 状态服务');
        if (!data.ok) throw new Error(data.error || '服务器登录态读取失败');
        if (controller.signal.aborted) return;
        setCookieInfo(data);
        setCookieHealth('ok');
        if (check) {
          const count = Number(data.verifiedAccountCount || 0);
          notice.current(
            data.checkSkipped
              ? '服务器登录态校验受管理权限保护，当前只显示保存状态。'
              : count > 0
                ? `${count} 个服务器登录态通过最近校验。`
                : data.hasCookie
                  ? '服务器已保存登录态，但目前没有通过最近校验的账号。'
                  : '暂无服务器登录态，可以填写备用 Cookie。',
          );
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setCookieInfo({ hasCookie: false, cookieCount: 0 });
        setCookieHealth('error');
        if (check) notice.current(error.message, 'error');
      } finally {
        if (requests.current.cookie === controller) requests.current.cookie = null;
      }
    },
    [apiBase, apiKey],
  );

  const checkConnection = useCallback(
    async (requestBase = apiBase, { notify = false } = {}) => {
      requests.current.health?.abort();
      const controller = new AbortController();
      requests.current.health = controller;
      setApiHealth('checking');
      void loadCookieStatus(false, requestBase);
      try {
        const response = await requestApi(
          '/api/health',
          { signal: controller.signal },
          {
            apiBase: requestBase,
            apiKey,
          },
        );
        const data = await readApiResponse(response, '后端服务');
        if (!data.ok) throw new Error(data.error || '后端没有返回可用状态');
        if (controller.signal.aborted) return;
        setApiHealth('ok');
        setApiAuthRequired(data.authRequired === true);
        setApiHealthDetail(data.authRequired === true ? '该后端要求访问密钥' : '');
        if (notify)
          notice.current(
            data.authRequired === true ? '后端连接成功，但它要求访问密钥。' : '后端连接成功。',
            'success',
            { popup: true, title: '连接正常' },
          );
      } catch (error) {
        if (controller.signal.aborted) return;
        setApiHealth('error');
        setApiHealthDetail(error.message);
        if (notify) notice.current(`后端连接失败：${error.message}`, 'error');
      } finally {
        if (requests.current.health === controller) requests.current.health = null;
      }
    },
    [apiBase, apiKey, loadCookieStatus],
  );

  useEffect(() => {
    // Avoid probing on every keystroke while editing the access key.
    const timer = window.setTimeout(() => {
      void checkConnection();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [checkConnection]);

  return {
    apiHealth,
    apiHealthDetail,
    apiAuthRequired,
    cookieHealth,
    cookieInfo,
    loadCookieStatus,
    checkConnection,
  };
}

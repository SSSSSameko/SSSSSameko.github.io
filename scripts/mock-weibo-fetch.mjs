const nativeFetch = globalThis.fetch;

globalThis.fetch = async (input, options = {}) => {
  const url = input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);
  if (!/^(api\.)?weibo\.com$/.test(url.hostname) && !url.hostname.endsWith('.weibo.cn')) {
    return await nativeFetch(input, options);
  }

  if (url.searchParams.get('id') !== '999999') {
    return new Response(JSON.stringify({ reposts: [], total_number: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  process.stdout.write('MOCK_FETCH_STARTED\n');
  return await new Promise((resolve, reject) => {
    const abort = () => {
      process.stdout.write('MOCK_FETCH_ABORTED\n');
      reject(Object.assign(new Error('mock request aborted'), { name: 'AbortError' }));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
};

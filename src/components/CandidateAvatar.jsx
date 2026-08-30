import { useEffect, useState } from 'react';

import { avatarFallback, avatarProxyUrl, safeAvatarUrl } from '../lib/avatar.js';

export default function CandidateAvatar({
  candidate,
  className = '',
  apiBase = '',
  decorative = false,
  priority = false,
  loadImage = true,
}) {
  const name = candidate?.screenName || candidate?.uid || '候选用户';
  const avatar = safeAvatarUrl(candidate?.avatar);
  const proxyAvatar = avatarProxyUrl(avatar, apiBase);
  const primarySource = loadImage ? proxyAvatar || avatar : '';
  const [source, setSource] = useState(primarySource);

  useEffect(() => setSource(primarySource), [primarySource]);

  function handleError() {
    if (source === proxyAvatar && avatar && avatar !== proxyAvatar) {
      setSource(avatar);
      return;
    }
    setSource('');
  }

  return (
    <span className={`candidate-avatar ${className}`}>
      {source ? (
        <img
          src={source}
          alt={decorative ? '' : `${name}的头像`}
          width="96"
          height="96"
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={handleError}
        />
      ) : (
        <span
          role={decorative ? undefined : 'img'}
          aria-hidden={decorative ? 'true' : undefined}
          aria-label={decorative ? undefined : `${name}的头像`}
        >
          {avatarFallback(name)}
        </span>
      )}
    </span>
  );
}

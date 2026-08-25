import React, { useEffect, useState } from 'react';

import { avatarFallback, avatarProxyUrl, safeAvatarUrl } from '../lib/avatar.js';

export default function CandidateAvatar({ candidate, className = '', apiBase = '' }) {
  const name = candidate?.screenName || candidate?.uid || '候选用户';
  const avatar = safeAvatarUrl(candidate?.avatar);
  const proxyAvatar = avatarProxyUrl(avatar, apiBase);
  const primarySource = proxyAvatar || avatar;
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
          alt={`${name}的头像`}
          width="96"
          height="96"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={handleError}
        />
      ) : (
        <span aria-hidden="true">{avatarFallback(name)}</span>
      )}
    </span>
  );
}

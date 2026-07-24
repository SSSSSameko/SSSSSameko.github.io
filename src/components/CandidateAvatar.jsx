import React, { useEffect, useState } from 'react';

import { avatarFallback, safeAvatarUrl } from '../lib/avatar.js';

export default function CandidateAvatar({ candidate, className = '' }) {
  const name = candidate?.screenName || candidate?.uid || '候选用户';
  const avatar = safeAvatarUrl(candidate?.avatar);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [avatar]);

  return (
    <span className={`candidate-avatar ${className}`}>
      {avatar && !failed ? (
        <img
          src={avatar}
          alt={`${name}的头像`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{avatarFallback(name)}</span>
      )}
    </span>
  );
}

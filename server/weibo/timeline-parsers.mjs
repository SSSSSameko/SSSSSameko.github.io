import crypto from 'node:crypto';
import { safeAvatarUrl } from '../../src/lib/avatar.js';
import { canonicalRepostId } from '../../src/lib/repostCandidates.js';

function stripHtml(input) {
  return String(input || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function stripLegacyHtml(input) {
  return stripHtml(String(input || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' '));
}

function candidateKey(raw) {
  const stable = [
    raw.uid,
    raw.screenName,
    raw.repostId,
    raw.text,
    raw.createdAt,
  ].filter(Boolean).join('|');
  return crypto.createHash('sha1').update(stable || crypto.randomUUID()).digest('hex').slice(0, 16);
}

export function normalizeCandidate(item, source) {
  const user = item?.user || item?.mblog?.user || item?.retweeted_status?.user || {};
  const uid = String(user.idstr || user.id || item.uid || item.user_id || '').trim().slice(0, 80);
  const screenName = String(user.screen_name || user.name || item.screen_name || item.name || '未命名用户').trim().slice(0, 120);
  const text = stripHtml(item.text || item.raw_text || item.mblog?.text || item.reason || '').slice(0, 1000);
  const createdAt = String(item.created_at || item.createdAt || item.mblog?.created_at || '').slice(0, 100);
  const repostId = canonicalRepostId(String(item.idstr || item.id || item.mid || item.mblog?.idstr || item.mblog?.id || '').trim().slice(0, 100), source);

  return {
    id: candidateKey({ uid, screenName, repostId, text, createdAt }),
    uid,
    screenName,
    avatar: safeAvatarUrl(user.profile_image_url || user.avatar_hd || user.avatar_large),
    verified: Boolean(user.verified),
    followers: Number(user.followers_count || 0),
    text,
    createdAt,
    repostId,
    source: String(source || '').slice(0, 80),
  };
}

export function desktopTimelineList(json) {
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.data)) return json.data.data;
  if (Array.isArray(json?.reposts)) return json.reposts;
  return [];
}

export function mobileTimelineList(json) {
  const data = json?.data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.reposts)) return data.reposts;
  if (Array.isArray(data?.cards)) return data.cards.flatMap((card) => card.card_group || card.mblog || card);
  if (Array.isArray(json?.reposts)) return json.reposts;
  return [];
}

function legacyDivs(html) {
  return [...String(html || '').matchAll(/<div class="c"[^>]*>([\s\S]*?)<\/div>/g)].map((match) => match[0]);
}

export function legacyMaxPage(html) {
  const mpInput = String(html || '').match(/<input[^>]*name="mp"[^>]*>/)?.[0] || '';
  const mpMatch = mpInput.match(/value="(\d+)"/);
  if (mpMatch) {
    const page = Number(mpMatch[1]);
    return Number.isFinite(page) ? page : null;
  }
  const pageLinks = [...String(html || '').matchAll(/[?&]page=(\d+)/g)].map((match) => {
    const page = Number(match[1]);
    return Number.isFinite(page) ? page : 0;
  });
  return pageLinks.length ? Math.max(...pageLinks) : null;
}

export function legacyTimelineList(html, page) {
  const praisePattern = /\u8d5e\[\d+\]/;
  return legacyDivs(html)
    .map((div) => ({ html: div, text: stripLegacyHtml(div) }))
    .filter((item) => praisePattern.test(item.text))
    .map((item, index) => {
      const anchors = [...item.html.matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
        href: match[1],
        text: stripLegacyHtml(match[2]),
      }));
      const userAnchor = anchors.find((anchor) => /(?:\/u\/|weibo\.cn\/|^\/)\d+/.test(anchor.href));
      const uid = userAnchor?.href.match(/(?:\/u\/|weibo\.cn\/|^\/)(\d+)/)?.[1] || '';
      const divRepostId = item.html.match(/\bid=(["'])M_([^"']+)\1/i)?.[2] || '';
      const statusAnchor = anchors.find((anchor) => /\/(?:comment|detail)\/[A-Za-z0-9]+/i.test(anchor.href));
      const attitudeAnchor = anchors.find((anchor) => /\/attitude\/[A-Za-z0-9]+/i.test(anchor.href));
      const linkedRepostId = statusAnchor?.href.match(/\/(?:comment|detail)\/([A-Za-z0-9]+)/i)?.[1]
        || attitudeAnchor?.href.match(/\/attitude\/([A-Za-z0-9]+)/i)?.[1]
        || '';
      const screenName = userAnchor?.text || item.text.split(':')[0] || '未命名用户';
      const createdAt = item.text.match(/\d{2}月\d{2}日\s+\d{2}:\d{2}|[\d:]+分钟前|昨天\s+\d{2}:\d{2}/)?.[0] || '';
      const cleanedText = item.text.replace(/^\[热门\]\s*/, '').trimStart();
      const text = cleanedText.startsWith(screenName)
        ? cleanedText.slice(screenName.length).replace(/^\s*:?\s*/, '').trim()
        : cleanedText.trim();
      return {
        idstr: divRepostId || linkedRepostId
          || `weibo-cn-${page}-${index}-${uid || crypto.createHash('sha1').update(item.text).digest('hex').slice(0, 10)}`,
        text,
        created_at: createdAt,
        user: {
          idstr: uid,
          screen_name: screenName,
        },
      };
    });
}

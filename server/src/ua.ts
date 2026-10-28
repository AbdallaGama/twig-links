export type Platform = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'chromeos' | 'other';

export interface ClientInfo {
  platform: Platform;
  osVersion: string | null;
  /** Device model when the user agent or client hints expose it. */
  model: string | null;
  browser: string;
  /** Name of the in-app browser / WebView host (instagram, facebook, ...), or null. */
  inApp: string | null;
  isBot: boolean;
  isMobile: boolean;
  /** True when Chrome's reduced UA hides the real Android version and model. */
  reducedUa: boolean;
}

const BOT_PATTERNS: RegExp[] = [
  /facebookexternalhit|facebot|meta-externalagent/i,
  /twitterbot|xbot/i,
  /slackbot|slack-imgproxy/i,
  /linkedinbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /discordbot/i,
  /skypeuripreview/i,
  /pinterest(bot)?\//i,
  /redditbot/i,
  /embedly/i,
  /snap url preview/i,
  /viber/i,
  /googlebot|google-inspectiontool|adsbot-google|mediapartners-google|google-pagerenderer/i,
  /bingbot|bingpreview/i,
  /applebot/i,
  /yandex(bot|images)/i,
  /duckduckbot/i,
  /baiduspider/i,
  /vkshare|odklbot/i,
  /iframely|outbrain|quora link preview|tumblr|mastodon|bluesky|cardyb/i,
  /\b(bot|crawler|spider|preview)\b/i,
];

const IN_APP_PATTERNS: Array<[string, RegExp]> = [
  ['instagram', /\bInstagram\b/],
  ['facebook', /FBAN|FBAV|FB_IAB|FBIOS|FB4A/],
  ['messenger', /\bMessenger\b|FBAN\/Messenger|Orca-Android/],
  ['twitter', /\bTwitter(?:Android)?\b/],
  ['linkedin', /LinkedInApp/],
  ['snapchat', /Snapchat/],
  ['tiktok', /musical_ly|BytedanceWebview|TikTok/],
  ['line', /\bLine\//],
  ['wechat', /MicroMessenger/],
  ['telegram', /Telegram/],
  ['pinterest', /\[Pinterest\//],
  ['gmail', /\bGSA\/|GoogleApp/],
];

export function isBot(userAgent: string): boolean {
  return BOT_PATTERNS.some((pattern) => pattern.test(userAgent));
}

export interface ClientHints {
  platformVersion?: string | null;
  model?: string | null;
}

export function parseUserAgent(userAgent: string, hints: ClientHints = {}): ClientInfo {
  const ua = userAgent || '';
  let platform: Platform = 'other';
  let osVersion: string | null = null;
  let model: string | null = null;
  let reducedUa = false;

  const ios = /\b(iPhone|iPad|iPod)\b/.exec(ua);
  const android = /Android\s*([\d.]+)?/.exec(ua);
  if (ios) {
    platform = 'ios';
    model = ios[1]!;
    const version = /OS (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(ua);
    if (version) osVersion = [version[1], version[2], version[3]].filter(Boolean).join('.');
  } else if (android) {
    platform = 'android';
    osVersion = android[1] ?? null;
    const device = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*[;)]/.exec(ua);
    model = device?.[1]?.trim() ?? null;
    if (model === 'K' || model === 'wv') {
      // Chrome UA reduction freezes these to "Android 10; K".
      reducedUa = model === 'K';
      model = null;
    }
    if (reducedUa) osVersion = null;
  } else if (/CrOS/.test(ua)) {
    platform = 'chromeos';
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    platform = 'macos';
    const version = /Mac OS X (\d+)[_.](\d+)/.exec(ua);
    if (version) osVersion = `${version[1]}.${version[2]}`;
  } else if (/Windows/.test(ua)) {
    platform = 'windows';
    const version = /Windows NT ([\d.]+)/.exec(ua);
    osVersion = version?.[1] ?? null;
  } else if (/Linux|X11/.test(ua)) {
    platform = 'linux';
  }

  if (platform === 'android') {
    const hintVersion = clean(hints.platformVersion);
    const hintModel = clean(hints.model);
    if (hintVersion) osVersion = hintVersion;
    if (hintModel) model = hintModel;
  }

  let inApp: string | null = null;
  for (const [name, pattern] of IN_APP_PATTERNS) {
    if (pattern.test(ua)) { inApp = name; break; }
  }
  if (!inApp && platform === 'android' && /;\s*wv\)/.test(ua)) inApp = 'webview';
  if (!inApp && platform === 'ios' && /AppleWebKit/.test(ua) && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) {
    inApp = 'webview';
  }

  return {
    platform,
    osVersion,
    model,
    browser: detectBrowser(ua),
    inApp,
    isBot: isBot(ua),
    isMobile: platform === 'ios' || platform === 'android',
    reducedUa,
  };
}

function detectBrowser(ua: string): string {
  if (/CriOS/.test(ua)) return 'chrome';
  if (/FxiOS|Firefox\//.test(ua)) return 'firefox';
  if (/EdgiOS|EdgA|Edg\//.test(ua)) return 'edge';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = value.replace(/^"|"$/g, '').trim();
  return stripped === '' ? null : stripped;
}

/** Normalises a version string to "major.minor" for comparisons. */
export function majorMinor(version: string | null | undefined): string | null {
  if (!version) return null;
  const parts = version.split(/[._]/).filter(Boolean);
  if (parts.length === 0) return null;
  return `${parts[0]}.${parts[1] ?? '0'}`;
}

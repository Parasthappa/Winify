// Never secrets in the DRM diagnostics' transcript (`npm start -- --drm-debug`),
// which gets pasted into bug reports: web addresses lose their query (Spotify's
// audio links carry signed access codes there), and tokens, token-like
// name=value pairs and any long opaque string are hidden.
function redact(text) {
  return String(text)
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1?[query hidden]')
    .replace(/\bBearer\s+[^\s"',]+/gi, 'Bearer [hidden]')
    .replace(/\b(access_token|refresh_token|id_token|token|code|code_verifier|client_secret|authorization|signature|sig)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, '$1$2[hidden]')
    .replace(/[A-Za-z0-9_\-+/]{40,}={0,2}/g, '[hidden]');
}

module.exports = { redact };
